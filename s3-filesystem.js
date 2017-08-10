const AWS = require('aws-sdk');
const S3FS = require('s3fs');
const moment = require('moment');
const winston = require('winston');
const json_templater = require('json-templater/object');

// STS S3 Enabler module
class STSS3Enabler {

  /**
   * create a new instance of STSS3Enabler
   * @param {Object} paramsObj containing:
   * {
   *     awsOptions: {
   *                   "accessKeyId": "",
   *                   "secretAccessKey": "",
   *                   "region": "ap-southeast-2"
   *                 },
   *     stsExpiryThresholdSeconds: 300,
   *     stsRoleArn: "arn:aws:iam::406406619500:role/role-myfiles-develop-s3",
   *     loggingConfig: {
   *                      "level":"debug",
   *                      "timestamp":true,
   *                      "colorize":true
   *                     },
   *     dynamicBucketPolicyTemplateString: "{\"Version\":\"2012-10-17\",\"Statement\":[{ ...... }]"
   *   }
   */
  constructor(paramsObj) {

    this.awsOptions = paramsObj.awsOptions;
    this.stsExpiryThresholdSeconds = paramsObj.stsExpiryThresholdSeconds;
    this.loggingConfig = paramsObj.loggingConfig;
    this.stsRoleArn = paramsObj.stsRoleArn;
    this.dynamicBucketPolicyTemplateString = paramsObj.dynamicBucketPolicyTemplateString;

    this.sts = new AWS.STS(this.awsOptions);
    this.logger = new (winston.Logger)({
      transports: [
        new (winston.transports.Console)(this.loggingConfig)
      ]
    });
  }

  /**
   * formats an STS bucket policy based on the provided bucketPath and appUserId
   * @param bucketPath
   * @param myAppUserId
   * @return {{DurationSeconds: number, ExternalId: *, RoleArn: value, RoleSessionName: *, Policy}}
   */
  getSTSParams(bucketPath, myAppUserId) {

// a bucket policy that *should* only allow access to this user's subfolder of the bucket.
    let dynamicBucketPolicy = json_templater(
      this.dynamicBucketPolicyTemplateString,
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
      RoleArn: this.stsRoleArn,
      RoleSessionName: myAppUserId,
      Policy: JSON.stringify(dynamicBucketPolicy)
    };
  }


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
  updateSTSCredentials(oldS3Params, appUserId, bucketPath) {
    this.logger.debug("updating STS credentials");
    let stsParams;
    let mustRegenerate = true;
    let self = this;

    return new Promise((resolve, reject) => {

      // if we have S3Params already, check timestamp to see if it's going to expire any time soon
      if (oldS3Params && oldS3Params.requestedTS) {
        stsParams = self.getSTSParams(bucketPath, appUserId);
        // add expiry duration to start ts, compare that to the current time
        if (moment(oldS3Params.requestedTS).add(stsParams.DurationSeconds, 'seconds').isBefore(moment().subtract(self.stsExpiryThresholdSeconds, 'seconds'))) {
          self.logger.debug("token is about to expire or has expired; renewing.");
          mustRegenerate = true;
        } else {
          // still current
          mustRegenerate = false;
        }
      }

      if (mustRegenerate) {

        if (!stsParams) {
          stsParams = self.getSTSParams(bucketPath, appUserId);
        }
        let ts = moment().toISOString(); // now
        self.sts.assumeRole(stsParams, function (err, data) {
            if (err) {
              self.logger.error(err, err.stack); // an error occurred
              reject(err);
            } else {
              self.logger.debug("successfully ensured credentials");
              // logger.debug(data);           // successful response

              let s3Params = {
                secretAccessKey: data.Credentials.SecretAccessKey,
                accessKeyId: data.Credentials.AccessKeyId,
                sessionToken: data.Credentials.SessionToken,
                expiration: data.Credentials.Expiration,
                region: self.awsOptions.region,
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
        self.logger.debug("credentials didn't need updating");
        resolve(oldS3Params);
      }
    });
  }


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
  getS3FS(oldS3Params, appUserId, bucketPath) {
    let self = this;
    return new Promise((resolve) => {
      self.logger.debug('initialising s3fs');
      self.updateSTSCredentials(oldS3Params, appUserId, bucketPath)
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
   * @return {Promise}
   */
  fsProxyOperation(s3fsOperationName, s3fsOperationParamArray, oldS3Params, appUserId, bucketPath) {
    let self = this;
    self.logger.debug(`fsProxyOperation(${s3fsOperationName},${s3fsOperationParamArray})`);
    return self.getS3FS(oldS3Params, appUserId, bucketPath)
      .then((results) => {
        let s3fsImpl = results.s3fs;

        return new Promise((resolve, reject) => {
          self.logger.debug(`calling s3fs.${s3fsOperationName}`);
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
  }
}

export default STSS3Enabler;