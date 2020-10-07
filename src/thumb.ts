import * as express from 'express';
import * as aws from 'aws-sdk';
import { RequestHandler } from 'express-serve-static-core';

const s3: aws.S3 = new aws.S3();

const LONG_CACHE_TIME: number = 60 * 60 * 24 * 30; //seconds
const SHORT_CACHE_TIME: number = 60; //seconds
const IMAGE_REQUEST_TIMEOUT: number = 10000; //ms
const CACHE_BUCKET: string = "dpla-thumbnails";
const PATH_PATTERN: RegExp = /^\/thumb\/([a-f0-9]{32})$/;

const thumb: RequestHandler = async function(req: express.Request, res: express.Response) {

  const itemIdPromise: Promise<string> = getItemId(req.path)
  
  if (!itemIdPromise) {
    res.sendStatus(400);
    res.end();
    return;
  }

  const itemId = await itemIdPromise

  Promise
  .resolve(itemId)
  .then((itemId: string) => lookupImageInS3(itemId))
  .then(
    //get image from s3
    (response) => { 
      setCacheHeaders(LONG_CACHE_TIME, res);
      getS3Url(itemId)
      .then((url) => proxyImage(url))
      .then((response) => {
        res.send(getImageStatusCode(response))
        res.pipe(response);
      })
    },
    //proxy image from contributor, queue cache request
    (err: string) => { 
      setCacheHeaders(SHORT_CACHE_TIME, res);
      lookupItemInElasticsearch(itemId)
      //.then(getImageUrlFromSearchResult())     
    }
  )

  res.sendStatus(200);
  res.end();
  return;
}

function getItemId(path: string): Promise<string> {
  const matchResult = PATH_PATTERN.exec(path)
  if (matchResult === null) {
    return Promise.resolve(matchResult[1]);
  } else {
    return Promise.reject("Bad item ID.");
  }
}

function getS3Key(id: string): string {
  const prefix = id.substr(0, 4).split("").join("/");
  return prefix + "/" + id + ".jpg";
}

function lookupImageInS3(id: string): Promise<aws.PromiseResult<aws.AWSError, aws.S3.Types.HeadObjectOutput>> {
  const params = { Bucket: CACHE_BUCKET, Key: getS3Key(id) };
  return s3.headObject(params).promise();
}

function getS3Url(id: string): Promise<string> {
  const params = { Bucket: CACHE_BUCKET, Key: getS3Key(id) };
  return s3.getSignedUrlPromise("getObject", params);
}

function lookupItemInElasticsearch(id: string): Promise<Response> {
  const elasticUrl = process.env.ELASTIC_URL || "http://search.internal.dp.la:9200/dpla_alias";
  return fetch(`${elasticUrl}/item/_search?q=id:${id}&_source=id,object`);
}

function getImageUrlFromSearchResult(json: Object): Promise<string> {

  if ((!json.hasOwnProperty("hits")) || (!json.hasOwnProperty("total"))) {
    return Promise.reject("Bad response from ElasticSearch.");
  }

  if (json["hits"]["total"] == 0) {
    return Promise.reject("No record found.");
  }

  const obj = json?.["hits"]?.hits?.[0]?._source?.object;
  let url = "";

  if (obj && Array.isArray(obj)) {
    url = obj[0]; 

  } else if (obj && typeof obj == "string") {
    url = obj;

  } else {
    return Promise.reject("Couldn't find image URL in record.");
  }

  if (!isProbablyURL(url)) {
    return Promise.reject("URL was malformed.");

  } else {
    return Promise.resolve(url);
  }
}

function isProbablyURL(s: string): boolean {
  return s && s.match(/^https?:\/\//) != null;
}

function setCacheHeaders(seconds: number, response: express.Response): void {
  const now = new Date().getTime();
  const expirationDateString = new Date(now + 1000 * seconds).toUTCString();
  response.setHeader("Cache-Control", `public, max-age=${seconds}`);
  response.setHeader("Expires", expirationDateString);
}

function withTimeout(msecs:number, promise: Promise<any>) {
  const timeout = new Promise((resolve, reject) => {
    setTimeout(() => {reject(new Error('Response from server timed out.'))}, msecs);
  });
  return Promise.race([timeout, promise]);
}

function proxyImage(imageUrl: string): Promise<Response> {
  const request: Request = new Request(imageUrl);
  request.headers.append("User-Agent", "DPLA Image Proxy");
  return withTimeout(IMAGE_REQUEST_TIMEOUT, fetch(request));
}

// try {
//   libRequest()
//     .on("response", response => {
//       this.handleImageResponse(response);
//     })
//     .on("error", error => {
//       this.handleImageConnectionError(error);
//     })
//     .pipe(this.response);
// } catch (e) {
//   console.error(e.stack);
//   this.returnError(500);
// }

function pruneHeaders(headers: Headers) {
  // Reduce headers to just those that we want to pass through
  const headerKeys: string[] = [ "content-length", "content-type", "last-modified", "date"];
  headers.forEach((header) => {
    if (headerKeys.indexOf(header.toLowerCase()) == -1) {
      headers.delete(header);
    }
  });
}

function getImageStatusCode(imgResponse: Response): number {
  // We have our own ideas of which response codes are appropriate for our client.
  switch (imgResponse.status) {
    case 200:
      return 200;
    case 404:
    case 410:
      // We treat a 410 as a 404, because our provider could correct
      // the `object' property in the item's metadata, meaning the
      // resource doesn't have to be "410 Gone".
      return 404;   
    default:
      // Other kinds of errors are just considered "bad gateway" errors
      // because we don't want to own them.
      return 502;
  }
}

function handleImageConnectionError(error) {
  console.error(`Error (${error.code}) for ${this.imageURL}`);
  if (error.code === "ETIMEDOUT") {
    this.returnError(504);
  } else {
    this.returnError(502);
  }
}

export default thumb;