Amazon STS Temporary Credentials (for S3 Use)
--- 

This is a little library intended for incorporating into your own 
[Amazon STS](http://docs.aws.amazon.com/STS/latest/APIReference/Welcome.html)
authorization proxy server.

### Overview
The idea is to let the client handle interfacing with S3, while your own server
handles authentication and authorization of the client (not included in this package).

The sequence is as follows:

1) client authenticates to your server (e.g. username/password).
2) Your own server performs authorization and returns temporary credentials. You'll 
need to build your own REST API for this (no middleware is assumed).
3) The client then communicates to S3 as normal. 
  
### Installation

```
npm install s3-sts-enabler
```

### Configuration

You need:

1. AWS Details
    ```js
    let awsOptions =  {
                        "accessKeyId": "",
                        "secretAccessKey": "",
                        "region": "ap-southeast-2"
                        }
    ```

2. stsExpiryThresholdSeconds : this tells the proxy to request a renewal of 
the credentials if they are due to expire within the next X seconds from now.
    ```js
    let stsExpiryThresholdSeconds = 300; // five minutes
    ```

3. stsRoleArn : the Amazon role to assume (via the STS 
[assumeRole](http://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html) function)
    ```js
    let stsRoleArn = "arn:aws:iam::406406619500:role/my-own-defined-role"
    ```
    
4. loggingConfig : [winston](https://github.com/winstonjs/winston)
logging configuration.
    ```js
    let loggingConfig = {
            "level":"debug",
            "timestamp":true,
            "colorize":true
        }
    ```
5. dynamicBucketPolicyTemplateString : A [json-templater](https://www.npmjs.com/package/json-templater)
string describing a bucket policy, with placeholders for the bucket path ```{{bucketPath}}``` and user ID 
```{{myAppUserId}}```.

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Sid": "AllowRootAndHomeListingOfBucket",
          "Action": [
            "s3:ListBucket"
          ],
          "Effect": "Allow",
          "Resource": [
            "arn:aws:s3:::{{bucketPath}}"
          ],
          "Condition": {
            "StringEquals": {
              "s3:prefix": [
                "",
                "{{myAppUserId}}/"
              ],
              "s3:delimiter": [
                "/"
              ]
            }
          }
        },
        {
          "Sid": "AllowListingOfUserFolder",
          "Action": [
            "s3:ListBucket"
          ],
          "Effect": "Allow",
          "Resource": [
            "arn:aws:s3:::{{bucketPath}}"
          ],
          "Condition": {
            "StringLike": {
              "s3:prefix": [
                "{{myAppUserId}}/*"
              ]
            }
          }
        },
        {
          "Sid": "AllowAllS3ActionsInUserFolder",
          "Action": [
            "s3:*"
          ],
          "Effect": "Allow",
          "Resource": [
            "arn:aws:s3:::{{bucketPath}}/{{myAppUserId}}/*"
          ]
        }
      ]
    }
    ```
    
    In this example, if we had a bucket of ```mybucket``` and a myAppUserId of ```myuserID```, the 
    user would be granted all S3 permissions for everything under ```mybucket/myuserID```.
    
### Usage
    
Take a look at [test.js](./test/test.js).

First, import the module
    
```js
let STSS3Enabler =require('s3-sts-enabler');

```

Then (on the server) create a new instance with all of the parameters from the [Configuration](#Configuration) section.

```js
    let stsEnabler = new STSS3Enabler({
      awsOptions: awsOptions,
      stsExpiryThresholdSeconds: stsExpiryThresholdSeconds,
      stsRoleArn: stsRoleArn,
      loggingConfig: loggingConfig,
      dynamicBucketPolicyTemplateString: require('../dynamicBucketPolicy.json')
    });

```

The instance returned is stateless so it can be reused. Now you can request temporary credentials, passing in the 
bucket name and the app user ID. It returns a promise containing the credentials :

```js
  // the first parameter is existing credentials; if they are truthy and have not expired then the 
  // existing credentials are returned; otherwise new credentials are obtained.
  let s3Params;
  stsEnabler.updateSTSCredentials(null, appUserId, bucketPath)
    .then((result) => {
      // result will be something like:
      // {
      //   secretAccessKey: 'ABCDEFG1234567',
      //   accessKeyId: 'Z1Y2X3',
      //   sessionToken: '1A2B3C4D',
      //   expiration: '2017-08-14T15:01:37Z',
      //   region: 'ap-southeast-2',
      //   requestedTS: 1502694121673
      // }      
    });
``` 

The result can then be returned to the client and used in S3 calls as normal.
