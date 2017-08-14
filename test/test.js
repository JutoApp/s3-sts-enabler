const assert = require('assert');
const config = require('config');
const winston = require('winston');

// config options (from config/test.json)
const awsOptions = config.get('aws.awsOptions');
const stsExpiryThresholdSeconds = config.get('aws.STSTokenRenewThresholdSeconds');
const stsRoleArn = config.get("aws.RoleArn");
const loggingConfig = config.get('loggingConfig');


const logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)(loggingConfig)
  ]
});

import STSS3Enabler from '../s3-filesystem';

describe('STSS3Enabler', function () {
  let stsEnabler;

  it('get a new STSS3Enabler', function (done) {
    stsEnabler = new STSS3Enabler({
      awsOptions: awsOptions,
      stsExpiryThresholdSeconds: stsExpiryThresholdSeconds,
      stsRoleArn: stsRoleArn,
      loggingConfig: loggingConfig,
      dynamicBucketPolicyTemplateString: require('./config/dynamicBucketPolicy.json')
    });
    assert.ok(stsEnabler);
    done();
  });

  const expiredCredentialsForTesting = {
    Credentials:
      {
        accessKeyId: 'ASIAJXORIE7NOLIQTFZQ',
        secretAccessKey: 'iUEPM3CBiGhYwdPcnov5HQYOoDxPLBJv+wzkYp98',
        sessionToken: 'FQoDYXdzEIj//////////wEaDMRGHDskmPyGuCv+DiKqA+lNl95i5y8JB/VGqi+cltSX5qXhkpolfKZ0Yu2ljIXLGsbqQ8W3fq5qrSvI6WAQFg8+4lycJnnWITfoWX4NdcfIldxMCawc/++ki/DrJSkigxApPeqhSu9etY/H+vBL3bm5YqY39V6WNj048+JQxYh7YW1AbkouO9JZU3MTIw/25+1bGZnKBNQ1UlOOu01AqL82i8MqcroTvHKrQWplpp/IIYxiQY0tRhLeDuDY+sarrESoFMVtb2o3w5d/gvBLAU0fks70FWRMua/KPKO2ndcAsTAIGT75V74OaUOtwOYyQD5MX2iHv/wZnaPHmyM3R4NI3hnNCf8r6piP0Lo6QAUyGWvloAoaasZDkhvzbQX8wQG6PJ8rxRfF82QRGzZwedZX9B9cmfdn6twWLK6IZBVu7AZGauawbJxNGnnB3kNkkZiT8OJRxf+pDIqsbi6b5cZAnZWqNT4CrtytHwgPFlaWjz4xYKGThfsvd3ufAs+ikqLXpzm4KK2Jv+LgcobTI+htHVxedgZx983F81csO0dwQTPtjrH6fQgqy9Rh8VOKwPu3omWyRFu0VyiX7qrMBQ==',
        expiration: '2017-08-09T07:32:43.000Z'
      }
  };

  let appUserId = 'allow_this';
  const bucketPath = config.get('aws.bucketPath');


  logger.debug(`writing ${appUserId}/message.txt`);
  let s3Params;

  it('get new credentials with expired credentials', function () {
    this.timeout(20000);
    // return stsEnabler.getS3FS(expiredCredentialsForTesting.Credentials, appUserId, bucketPath);
    let promise = stsEnabler.updateSTSCredentials(expiredCredentialsForTesting, appUserId, bucketPath);
    logger.debug(promise);
    return promise.then((result) => {
      logger.debug(result);
      assert((result !== null), "new credentials should have been returned");
      s3Params = result;
      return result;
    })
  });

  let time = new Date().getTime();

  it('write a new file to the bucket with an allowed userID prefix', function () {
    return stsEnabler.fsProxyOperation('writeFile', [`${appUserId}/${time}/message.txt`, 'Hello Node'], s3Params, appUserId, bucketPath)
      .then((result) => {
        logger.debug(result);
        assert.ok(result);
        assert.ok(result.ETag);
        return result;
      });
  });

  it('read folder and check that the file is there', function () {
    return stsEnabler.fsProxyOperation('readdirp', [`${appUserId}/`], s3Params, appUserId, bucketPath)
      .then((data)=>{
        logger.debug(data);
        assert.ok(data);
        assert.ok((data.indexOf(`${time}/message.txt`) !== -1), "the file we wrote wasn't there");
        return data;
      });

  });

  it('remove the file we created', function () {
    return stsEnabler.fsProxyOperation('unlink', [`${appUserId}/${time}/message.txt`], s3Params, appUserId, bucketPath)
      .then((data)=>{
        logger.debug(data);
        assert.ok(data);
        assert.ok(data.DeleteMarker);
        return data;
      });

  });

  it('read folder and check that the file is NOT there any more', function () {
    return stsEnabler.fsProxyOperation('readdirp', [`${appUserId}/`], s3Params, appUserId, bucketPath)
      .then((data)=>{
        logger.debug(data);
        assert.ok(data);
        assert.ok((data.indexOf(`${time}/message.txt`) === -1), "the file we wrote was STILL there");
        return data;
      });
  });

  it("check that we can't read a folder that we SHOULD NOT be able to read", function () {
    return stsEnabler.fsProxyOperation('readdirp', [`deny_this/`], s3Params, appUserId, bucketPath)
      .then((result)=>{
        throw new Error('We should not have been able to read that. Promise was unexpectedly fulfilled. Result: ' + result);
      }, function rejected(error) {
        assert.ok(true);
      });
  });

  it("check that we can't write a file that we SHOULD NOT be able to write to", function () {
    return stsEnabler.fsProxyOperation('writeFile', [`deny_this/message.txt`, 'Hello Node'], s3Params, appUserId, bucketPath)
      .then((result)=>{
        throw new Error('We should not have been able to write that. Promise was unexpectedly fulfilled. Result: ' + result);
      }, function rejected(error) {
        assert.ok(true);
      });
  });

});

