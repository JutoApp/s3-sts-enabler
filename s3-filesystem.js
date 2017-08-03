#!/usr/bin/env node

const fs = require('fs')
const AWS = require('aws-sdk');
const config = require('config');
const awsOptions = config.get('aws.awsOptions');
const bucketPath = config.get('aws.bucketPath');
const S3FS = require('s3fs');
var sts = new AWS.STS(awsOptions);

let myAppUserId = "allow_this";

// a bucket policy that *should* only allow access to this user's subfolder of the bucket.
let dynamicBucketPolicy =
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AllowRootAndHomeListingOfBucket",
        "Action": ["s3:ListBucket"],
        "Effect": "Allow",
        "Resource": [`arn:aws:s3:::${bucketPath}`],
        "Condition": { "StringEquals": { "s3:prefix": ["", `${myAppUserId}/`], "s3:delimiter": ["/"] } }
      },
      {
        "Sid": "AllowListingOfUserFolder",
        "Action": ["s3:ListBucket"],
        "Effect": "Allow",
        "Resource": [`arn:aws:s3:::${bucketPath}`],
        "Condition": { "StringLike": { "s3:prefix": [`${myAppUserId}/*`] } }
      },
      {
        "Sid": "AllowAllS3ActionsInUserFolder",
        "Action": ["s3:*"],
        "Effect": "Allow",
        "Resource": [`arn:aws:s3:::${bucketPath}/${myAppUserId}/*`]
      }
    ]
  };

var STSParams = {
  DurationSeconds: 3600,
  ExternalId: myAppUserId,
  RoleArn: config.get("aws.RoleArn"),
  RoleSessionName: myAppUserId,
  Policy: JSON.stringify(dynamicBucketPolicy)
};


console.log(STSParams);

new Promise((resolve, reject) => {
  console.log("assuming role...");
  sts.assumeRole(STSParams, function (err, data) {
    if (err) {
      console.error(err, err.stack); // an error occurred
      reject(err);
    } else {
      console.log("successfully assumed role! response:")
      console.log(data);           // successful response
      resolve(data);
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
}).then((result) => {

  console.log("creating S3FS instance...");
  // all the property names in the S3FS 
  let s3Params = {
    secretAccessKey: result.Credentials.SecretAccessKey,
    accessKeyId: result.Credentials.AccessKeyId,
    sessionToken: result.Credentials.SessionToken,
    region: awsOptions.region
  }
  let fsImpl = new S3FS(bucketPath, s3Params);

  console.log(`writing ${myAppUserId}/message.txt`);
  fsImpl.writeFile(`${myAppUserId}/message.txt`, 'Hello Node')
    .then(() => {
      console.log(`It's saved! Reading folder ${myAppUserId}/ :`);
      return fsImpl.readdirp(`${myAppUserId}/`);
    }).then(
    (data) => { // results of listContents
      console.log(data);
      return data;
    }
    ).catch((e) => {
      console.error(e);
    }
  ).then(()=>{
  // ==== test that our temp credentials can't access stuff that they shouldn't ===
    console.log(`Attempting to write /deny_this/message.txt (should fail...)`);
    fsImpl.writeFile(`/deny_this/message.txt`, 'Hello Node')
      .then(() => {
        console.log(`It's saved! Reading folder deny_this/ :`);
        return fsImpl.readdirp(`deny_this/`);
      }).then(
      (data) => { // results of listContents
        console.log(data);
      }
      ).catch((e) => {
        console.error(e);
      }
    );
  })

  


})



