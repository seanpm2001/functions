let parse = require('@architect/parser')
let mime = require('mime-types')
let path = require('path')
let fs = require('fs')
let util = require('util')
let aws = require('aws-sdk')
let transform = require('./transform')

let readFile = util.promisify(fs.readFile)
let encoding = 'utf8'
let arcFile = path.join(process.cwd(), 'node_modules', '@architect', 'shared', '.arc')
let arc
let env = process.env.NODE_ENV

/**
 * reads a file; possibly transforms and caches it
 *
 * @param Key - the Key for the S3 Bucket
 * @param config - the full arc.proxy.pubic config
 * @returns - an HTTP Lambda friendly response {headers, body, status}
 */
module.exports = async function read(Key, config={}, reqHeaders) {

  let {bucket, cacheControl} = config

  try {
    // assign response below
    let res

    // gets the default content-type from the Key
    let type = mime.contentType(path.extname(Key))

    // set up headers defining remote caching
    let nopes = [
      'text/html',
      'application/json',
    ]
    // TODO make this production-only
    let neverCache = nopes.some(n => type.startsWith(n)) //&& env === 'production'

    // normalize if-none-match header to lower case; it differs between environments
    let ifNoneMatch = reqHeaders && reqHeaders[Object.keys(reqHeaders).find(k => k.toLowerCase() === 'if-none-match')]

    // default headers
    let headers = {
      'content-type': type,
      'cache-control': cacheControl ? cacheControl : 'max-age=86400'
    }
    if (neverCache && !cacheControl) {
      headers['cache-control'] = 'no-store'
    }

    if (env === 'testing') {
      // Lookup the blob in ./public
      // assuming we're running from a lambda in src/**/*
      let filePath = path.join(process.cwd(), '..', '..', '..', 'public', Key)
      if (!fs.existsSync(filePath))
        throw ReferenceError(`${filePath} not found`)

      // read the file
      let body = await readFile(filePath, {encoding})
      res = transform({
        Key,
        config,
        defaults: {
          headers: {'content-type': type},
          body
        },
      })
    }

    // Lookup the Bucket by reading node_modules/@architect/shared/.arc
    if (!arc && !bucket) {
      // only do this once
      let raw = await readFile(arcFile, {encoding})
      arc = parse(raw)
    }

    // get the Bucket
    let Bucket = bucket? bucket[env] : getBucket(arc.static)

    // strip staging/ and production/ from req urls
    if (Key.startsWith('staging/') || Key.startsWith('production/'))
      Key = Key.replace('staging/', '').replace('production/')

    // add path prefix
    if (bucket && bucket.folder)
      Key = `${bucket.folder}/${Key}`

    // set up s3 and its params
    let s3 = new aws.S3
    let params = { Bucket, Key }

    // if client sends if-none-match, use it in s3 getObject params
    if (ifNoneMatch && !neverCache) { params.IfNoneMatch = ifNoneMatch }
    let matchedETag = false

    let result = await s3.getObject(params)
      .promise()
      .catch(e => {
        // ETag matches (NotModified), so don't transit the file
        if (e.code === 'NotModified') {
          matchedETag = true
          headers.ETag = ifNoneMatch
          res = {
            statusCode: 304,
            headers,
          }
        }
        else throw Error
      })

    // no ETag found, return the blob
    if (!matchedETag) {
      headers.ETag = result.ETag
      res = transform({
        Key,
        config,
        defaults: {
          headers,
          body: result.Body.toString()
        },
      })
    }
    return res
  }
  catch(e) {
    // render the error to html
    let headers = {'content-type':'text/html; charset=utf8'}

    if (env === 'testing') {
      //look for public/404.html
      let http404 = path.join(process.cwd(), '..', '..', '..', 'public', '404.html')
      let exists = fs.existsSync(http404)
      if (exists) {
        let body = await readFile(http404, {encoding})
        return {headers, statusCode:404, body}
      }
    }

    if (env === 'staging' || env === 'production') {
      //look for 404.html on s3
      try {
        if (!arc && !bucket) {
          let raw = await readFile(arcFile, {encoding})
          arc = parse(raw)
        }
        let Bucket = bucket? bucket[env] : getBucket(arc.static)
        let Key = bucket && bucket.folder? `${bucket.folder}/404.html` : '404.html'
        let s3 = new aws.S3
        let result = await s3.getObject({Bucket, Key}).promise()
        let body = result.Body.toString()
        return {headers, statusCode:404, body}
      }
      catch(er) {
        // noop if the 404 isn't there
      }
    }

    // final err fallback
    let err = `
      <h1>${e.name}</h1>
      <pre>${e.code}</pre>
      <p>${e.message}</p>
      <pre>${e.stack}</pre>
    `
    return {headers, body:err}
  }
}

// helper returns the @static value for the current NODE_ENV
function getBucket(static) {
  let staging
  let production
  static.forEach(thing=> {
    if (thing[0] === 'staging') {
      staging = thing[1]
    }
    if (thing[0] === 'production') {
      production = thing[1]
    }
  })
  if (env === 'staging')
    return staging
  if (env === 'production')
    return production
}
