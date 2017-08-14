'use strict';

var _createClass = function () {
  function defineProperties(target, props) {
    for (var i = 0; i < props.length; i++) {
      var descriptor = props[i];
      descriptor.enumerable = descriptor.enumerable || false;
      descriptor.configurable = true;
      if ("value" in descriptor) descriptor.writable = true;
      Object.defineProperty(target, descriptor.key, descriptor);
    }
  }

  return function (Constructor, protoProps, staticProps) {
    if (protoProps) defineProperties(Constructor.prototype, protoProps);
    if (staticProps) defineProperties(Constructor, staticProps);
    return Constructor;
  };
}();

function _classCallCheck(instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError("Cannot call a class as a function");
  }
}

var AWS = require('aws-sdk');
var S3FS = require('s3fs');
var moment = require('moment');
var winston = require('winston');
var json_templater = require('json-templater/object');

// STS S3 Enabler module

var STSS3Enabler = function () {

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
  function STSS3Enabler(paramsObj) {
    _classCallCheck(this, STSS3Enabler);

    this.awsOptions = paramsObj.awsOptions;
    this.stsExpiryThresholdSeconds = paramsObj.stsExpiryThresholdSeconds;
    this.loggingConfig = paramsObj.loggingConfig;
    this.stsRoleArn = paramsObj.stsRoleArn;
    this.dynamicBucketPolicyTemplateString = paramsObj.dynamicBucketPolicyTemplateString;

    this.sts = new AWS.STS(this.awsOptions);
    this.logger = new winston.Logger({
      transports: [new winston.transports.Console(this.loggingConfig)]
    });
  }

  /**
   * formats an STS bucket policy based on the provided bucketPath and appUserId
   * @param bucketPath
   * @param myAppUserId
   * @return {{DurationSeconds: number, ExternalId: *, RoleArn: value, RoleSessionName: *, Policy}}
   */


  _createClass(STSS3Enabler, [{
    key: 'getSTSParams',
    value: function getSTSParams(bucketPath, myAppUserId) {

      // a bucket policy that *should* only allow access to this user's subfolder of the bucket.
      var dynamicBucketPolicy = json_templater(this.dynamicBucketPolicyTemplateString, {
        bucketPath: bucketPath,
        myAppUserId: myAppUserId
      });

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

  }, {
    key: 'updateSTSCredentials',
    value: function updateSTSCredentials(oldS3Params, appUserId, bucketPath) {
      this.logger.debug("updating STS credentials");
      var stsParams = void 0;
      var mustRegenerate = true;
      var self = this;

      return new Promise(function (resolve, reject) {

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
          var ts = moment().toISOString(); // now
          self.sts.assumeRole(stsParams, function (err, data) {
            if (err) {
              self.logger.error(err, err.stack); // an error occurred
              reject(err);
            } else {
              self.logger.debug("successfully ensured credentials");
              // logger.debug(data);           // successful response

              var s3Params = {
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
          });
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

  }, {
    key: 'getS3FS',
    value: function getS3FS(oldS3Params, appUserId, bucketPath) {
      var self = this;
      return new Promise(function (resolve) {
        self.logger.debug('initialising s3fs');
        self.updateSTSCredentials(oldS3Params, appUserId, bucketPath).then(function (result) {
          // result is an object containing credentials

          var s3fsImpl = new S3FS(bucketPath, result);
          resolve({
            s3fs: s3fsImpl,
            s3Params: result
          });
        });
      });
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

  }, {
    key: 'fsProxyOperation',
    value: function fsProxyOperation(s3fsOperationName, s3fsOperationParamArray, oldS3Params, appUserId, bucketPath) {
      var self = this;
      self.logger.debug('fsProxyOperation(' + s3fsOperationName + ',' + s3fsOperationParamArray + ')');
      return self.getS3FS(oldS3Params, appUserId, bucketPath).then(function (results) {
        var s3fsImpl = results.s3fs;

        return new Promise(function (resolve, reject) {
          self.logger.debug('calling s3fs.' + s3fsOperationName);
          s3fsImpl[s3fsOperationName].apply(s3fsImpl, s3fsOperationParamArray) // make the call to the originally requested operation
            .then(function (result) {
              resolve(result); // resolve with result from proxied s3fs operation
            }, function (err) {
              // onRejected i.e. s3fsImpl.call threw an error
              reject(err); // reject with error from proxied s3fs operation
            }).catch(function (e) {
            reject(e);
          });
        });
      });
    }
  }]);

  return STSS3Enabler;
}();

module.exports = STSS3Enabler;