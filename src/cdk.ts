import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { join as pathJoin } from 'path';

import { Stack, RemovalPolicy } from 'aws-cdk-lib';
import {
  HttpApi,
  HttpMethod,
  PayloadFormatVersion,
} from '@aws-cdk/aws-apigatewayv2-alpha';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';

import {
  CloudFormationClient,
  CreateStackCommand,
  Capability,
} from '@aws-sdk/client-cloudformation';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import { toCloudFormation } from './utils';

const REGION = 'eu-central-1';
const LAMBDA_BUCKET = 'cdk-test-tfn-lambdas';

/* -----------------------------------------------------------------------------
 * Utils
 * ---------------------------------------------------------------------------*/
function generateUUID() {
  return randomBytes(4).toString('hex');
}

/* -----------------------------------------------------------------------------
 * Stack definition
 * ---------------------------------------------------------------------------*/

type GenerateStackOptions = {
  deploymentName: string;
  lambdaBucketName: string;
};

type LambdaPackage = {
  functionName: string;
};

type SingleDeploymentProps = {
  deploymentName: string;
  lambdaBucketName: string;
  functionName: string;
};

class SingleDeploymentStack extends Stack {
  constructor(props: SingleDeploymentProps) {
    super();

    const { deploymentName, lambdaBucketName, functionName } = props;

    /**
     * External S3 bucket where the code for the Lambda is stored
     */
    const lambdaBucket = Bucket.fromBucketArn(
      this,
      'lambda-storage',
      `arn:aws:s3:::${lambdaBucketName}`
    );

    // Internal function name, since the name of the resource in AWS will get
    // prefixed with the deploymentname already
    const internalFunctionName = 'helloWorld';

    const functionCode = new lambda.S3Code(lambdaBucket, `${functionName}.zip`);

    const lambdaRole = new Role(this, 'Role', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Example role',
    });

    // Lambda
    const lambdaFn = new lambda.Function(this, internalFunctionName, {
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'index.handler',
      code: functionCode,
      role: lambdaRole,
    });

    // LogGroup for Lambda
    // We create the logGroup manually here, because setting the retention on
    // the function does not work
    // See: https://milangatyas.com/Blog/Detail/8/set-aws-lambda-log-group-retention-with-aws-c
    new LogGroup(this, `logGroup${internalFunctionName}`, {
      logGroupName: `/aws/lambda/${lambdaFn.functionName}`,
      retention: RetentionDays.FIVE_DAYS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    lambdaRole.addToPolicy(
      new PolicyStatement({
        actions: ['logs:PutLogEvents', 'logs:CreateLogStream'],
        resources: ['arn:aws:logs:*:*:log-group:/aws/lambda/*'],
      })
    );

    // API Gateway
    const httpApi = new HttpApi(this, deploymentName, {});

    const lambdaIntegration = new HttpLambdaIntegration('lambda', lambdaFn, {
      payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: lambdaIntegration,
    });
  }
}

async function generateStack({
  deploymentName,
  lambdaBucketName,
}: GenerateStackOptions) {
  const s3Client = new S3Client({
    region: REGION,
  });

  // Upload the source of the function
  const functionName = `${deploymentName}_${generateUUID()}`;
  const putObjectCommand = new PutObjectCommand({
    Bucket: lambdaBucketName,
    Key: `${functionName}.zip`,
    Body: createReadStream(pathJoin(__dirname, '../lambda.zip')),
  });
  await s3Client.send(putObjectCommand);

  const stack = new SingleDeploymentStack({
    deploymentName,
    functionName,
    lambdaBucketName,
  });

  return toCloudFormation(stack);
}

/* -----------------------------------------------------------------------------
 * Create resources
 * ---------------------------------------------------------------------------*/

async function main() {
  // Stackname must match the following pattern: [a-zA-Z][-a-zA-Z0-9]*
  const deploymentName = `tfn-${+new Date()}`;

  const template = await generateStack({
    deploymentName,
    lambdaBucketName: LAMBDA_BUCKET,
  });

  console.log('template: ', JSON.stringify(template, null, 2));

  const client = new CloudFormationClient({ region: REGION });
  const command = new CreateStackCommand({
    StackName: deploymentName,
    TemplateBody: JSON.stringify(template),
    Capabilities: [Capability.CAPABILITY_IAM],
  });
  const response = await client.send(command);

  console.log(response);
}

main();
