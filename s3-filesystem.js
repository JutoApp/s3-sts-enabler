#!/usr/bin/env node

const AWS = require('aws-sdk');
const config = require('config');
const S3FS = require('s3fs');
const moment = require('moment');
const winston = require('winston');
let json_templater = require('json-templater/object');

const awsOptions = config.get('aws.awsOptions');
const stsExpiryThresholdSeconds = config.get('aws.STSTokenRenewThresholdSeconds');
const sts = new AWS.STS(awsOptions);

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)(config.get('loggingConfig'))
  ]
});

/**
 * formats an STS bucket policy based on the provided bucketPath and appUserId
 * @param bucketPath
 * @param myAppUserId
 * @return {{DurationSeconds: number, ExternalId: *, RoleArn: value, RoleSessionName: *, Policy}}
 */
let getSTSParams = function(bucketPath, myAppUserId) {

// a bucket policy that *should* only allow access to this user's subfolder of the bucket.
  let dynamicBucketPolicy = json_templater(
    require('./dynamicBucketPolicy.json'),
    {
      bucketPath: bucketPath,
      myAppUserId: myAppUserId
    }
  );

  // logger.debug(JSON.stringify(dynamicBucketPolicy, null, 2));

  return {
    // DurationSeconds: 3600,
    DurationSeconds: 900,
    ExternalId: myAppUserId,
    RoleArn: config.get("aws.RoleArn"),
    RoleSessionName: myAppUserId,
    Policy: JSON.stringify(dynamicBucketPolicy)
  };
};

/**
 * Updates the STS credentials if the given oldS3Params is going to expire or if it hasn't been initialised yet.
 * @param {Object} oldS3Params - old S3 params, if available. Otherwise null.
 * @param {String} appUserId - the userID which will be used as a prefix within the bucket
 * @param {String} bucketPath - the bucket name and path
 * @return {Promise} - resolves with an s3Params object that can be used as credentials for s3fs e.g.
 * <code>
 *   {
 *            secretAccessKey: data.Credentials.SecretAccessKey,
 *            accessKeyId: data.Credentials.AccessKeyId,
 *            sessionToken: data.Credentials.SessionToken,
 *            expiration: data.Credentials.Expiration,
 *            region: awsOptions.region,
 *            requestedTS: ts
 *          }
 * </code>
 */
let updateSTSCredentials = function (oldS3Params, appUserId, bucketPath) {
  logger.debug("updating STS credentials");
  let stsParams;
  let mustRegenerate = true;
  return new Promise((resolve, reject) => {

    // if we have S3Params already, check timestamp to see if it's going to expire any time soon
    if (oldS3Params && oldS3Params.requestedTS) {
      stsParams = getSTSParams(bucketPath, appUserId);
      // add expiry duration to start ts, compare that to the current time
      if (moment(oldS3Params.requestedTS).add(stsParams.DurationSeconds,'seconds').isBefore(moment().subtract(stsExpiryThresholdSeconds, 'seconds'))) {
        logger.debug("token is about to expire or has expired; renewing.");
        mustRegenerate = true;
      } else {
        // still current
        mustRegenerate = false;
      }
    }

    if (mustRegenerate) {

      if (!stsParams) {
        stsParams = getSTSParams(bucketPath, appUserId);
      }
      let ts = moment().toISOString(); // now
      sts.assumeRole(stsParams, function (err, data) {
          if (err) {
            logger.error(err, err.stack); // an error occurred
            reject(err);
          } else {
            logger.debug("successfully ensured credentials");
            // logger.debug(data);           // successful response

            let s3Params = {
              secretAccessKey: data.Credentials.SecretAccessKey,
              accessKeyId: data.Credentials.AccessKeyId,
              sessionToken: data.Credentials.SessionToken,
              expiration: data.Credentials.Expiration,
              region: awsOptions.region,
              requestedTS: ts
            };
            resolve(s3Params);
          }
          /*
          data = {
           Credentials: {
            AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
            Expiration: <Date Representation>,
            SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY",
            SessionToken: "AQoEXAMPLEH4aoAH0gNCAPyJxz4BlCFFxWNE1OPTgk5TthT+FvwqnKwRcOIfrRh3c/LTo6UDdyJwOOvEVPvLXCrrrUtdnniCEXAMPLE/IvU1dYUg2RVAJBanLiHb4IgRmpRV3zrkuWJOgQs8IZZaIv2BXIa2R4OlgkBN9bkUDNCJiBeb/AXlzBBko7b15fjrBs2+cTQtpZ3CYWFXG8C5zqx37wnOE49mRl/+OtkIKGO7fAE"
           }
          }
          */
        }
      );
    } else {
      logger.debug("credentials didn't need updating");
      resolve(oldS3Params);
    }
  });
};

/**
 * Returns a promise that resolves with an object containing an S3FS instance and (temporary) S3 AWS Credentials.
 * @param {Object} oldS3Params - old S3 params, if available. Otherwise null.
 * @param {String} appUserId - the userID which will be used as a prefix within the bucket
 * @param {String} bucketPath - the bucket name and path
 * @return {Promise} - resolves with an s3fs instance and an s3Params object that can be used as credentials for s3fs e.g.
 * <code>
 * {
 *   s3fs: s3fsImpl,
 *   s3Params: result
 * }
 * </code>
 */
function getS3FS(oldS3Params, appUserId, bucketPath) {
  return new Promise((resolve) => {
      logger.debug('initialising s3fs');
      updateSTSCredentials(oldS3Params, appUserId, bucketPath)
      .then((result) => { // result is an object containing credentials

        let s3fsImpl = new S3FS(bucketPath, result);
        resolve({
          s3fs: s3fsImpl,
          s3Params: result
        });
      })
  })
}

/**
 * Proxies an s3fs operation, transparently handling the usage of temporary STS credentials
 * @param s3fsOperationName
 * @param s3fsOperationParamArray
 * @param oldS3Params
 * @param appUserId
 * @param bucketPath
 * @return {Promise.<TResult>}
 */
let fsProxyOperation = function (s3fsOperationName, s3fsOperationParamArray, oldS3Params, appUserId, bucketPath) {
  logger.debug(`fsProxyOperation(${s3fsOperationName},${s3fsOperationParamArray})`);
  return getS3FS(oldS3Params, appUserId, bucketPath)
    .then((results) => {
      let s3fsImpl = results.s3fs;

      return new Promise((resolve, reject) => {
        logger.debug(`calling s3fs.${s3fsOperationName}`);
        s3fsImpl[s3fsOperationName].apply(s3fsImpl, s3fsOperationParamArray) // make the call to the originally requested operation
          .then(
            (result) => {
              resolve(result); // resolve with result from proxied s3fs operation
            },
            (err) => { // onRejected i.e. s3fsImpl.call threw an error
              reject(err); // reject with error from proxied s3fs operation
            }
          ).catch((e) => {
            reject(e);
        });
      });
    });
};

// test harness
const test = function() {

  let expiredCredentialsForTesting = {
    ResponseMetadata: {RequestId: 'd636a105-7cd2-11e7-b150-4702cdeadfc6'},
    Credentials:
      {
        accessKeyId: 'ASIAJXORIE7NOLIQTFZQ',
        secretAccessKey: 'iUEPM3CBiGhYwdPcnov5HQYOoDxPLBJv+wzkYp98',
        sessionToken: 'FQoDYXdzEIj//////////wEaDMRGHDskmPyGuCv+DiKqA+lNl95i5y8JB/VGqi+cltSX5qXhkpolfKZ0Yu2ljIXLGsbqQ8W3fq5qrSvI6WAQFg8+4lycJnnWITfoWX4NdcfIldxMCawc/++ki/DrJSkigxApPeqhSu9etY/H+vBL3bm5YqY39V6WNj048+JQxYh7YW1AbkouO9JZU3MTIw/25+1bGZnKBNQ1UlOOu01AqL82i8MqcroTvHKrQWplpp/IIYxiQY0tRhLeDuDY+sarrESoFMVtb2o3w5d/gvBLAU0fks70FWRMua/KPKO2ndcAsTAIGT75V74OaUOtwOYyQD5MX2iHv/wZnaPHmyM3R4NI3hnNCf8r6piP0Lo6QAUyGWvloAoaasZDkhvzbQX8wQG6PJ8rxRfF82QRGzZwedZX9B9cmfdn6twWLK6IZBVu7AZGauawbJxNGnnB3kNkkZiT8OJRxf+pDIqsbi6b5cZAnZWqNT4CrtytHwgPFlaWjz4xYKGThfsvd3ufAs+ikqLXpzm4KK2Jv+LgcobTI+htHVxedgZx983F81csO0dwQTPtjrH6fQgqy9Rh8VOKwPu3omWyRFu0VyiX7qrMBQ==',
        expiration: '2017-08-09T07:32:43.000Z'
      },
    AssumedRoleUser:
      {
        AssumedRoleId: 'AROAJLY4BA6JY6DVTBR7Q:allow_this',
        Arn: 'arn:aws:sts::406406619500:assumed-role/role-myfiles-develop-s3/allow_this'
      },
    PackedPolicySize: 51
  };

  let appUserId = 'allow_this';
  const bucketPath = config.get('aws.bucketPath');

  logger.debug(`writing ${appUserId}/message.txt`);
  let s3Params;
  getS3FS(expiredCredentialsForTesting.Credentials, appUserId, bucketPath) // start with expired credentials!
  // getS3FS() // start with expired credentials!
    .then((result) => {
      s3Params = result.s3Params;
      return fsProxyOperation('writeFile', [`${appUserId}/message.txt`, 'Hello Node'], s3Params, appUserId, bucketPath)
    })
    .then(() => {
      logger.debug(`It's saved! Reading folder ${appUserId}/ :`);
      return fsProxyOperation('readdirp', [`${appUserId}/`], s3Params, appUserId, bucketPath);
    }).then(
    (data) => { // results of listContents
      logger.debug(data);
      return data;
    }
  ).catch((e) => {
      logger.error(e);
    }
  ).then(() => {
    // ==== test that our temp credentials can't access stuff that they shouldn't ===
    logger.debug(`Attempting to write /deny_this/message.txt (should fail...)`);
    fsProxyOperation('writeFile', [`/deny_this/message.txt`, 'Hello Node'], s3Params, appUserId, bucketPath)
      .then(() => {
        logger.debug(`It's saved! Reading folder deny_this/ :`);
        return fsProxyOperation('readdirp', [`deny_this/`], s3Params, appUserId, bucketPath);
      }).then(
      (data) => { // results of listContents
        logger.debug(data);
      }
    ).catch((e) => {
        logger.error(e);
      }
    );
  });

};

test();