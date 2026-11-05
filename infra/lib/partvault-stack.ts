import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as s3notifications from "aws-cdk-lib/aws-s3-notifications";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PartVaultStackProps extends cdk.StackProps {
  stage: string;
}

export class PartVaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PartVaultStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const assetPath = (...parts: string[]) => path.join(__dirname, "..", "..", ...parts);

    // DynamoDB single-table
    const table = new dynamodb.Table(this, "PartVaultTable", {
      tableName: `partvault-${stage}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // S3 uploads bucket (private)
    const uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      bucketName: `partvault-${stage}-uploads-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: "AbortIncompleteMultipart",
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ["*"],
          allowedHeaders: ["Content-Type", "Content-Length", "x-amz-meta-*", "Idempotency-Key"],
          exposedHeaders: ["ETag"],
          maxAge: 3600,
        },
      ],
      eventNotifications: undefined,
    });

    // SQS + DLQ
    const dlq = new sqs.Queue(this, "ProcessingDLQ", {
      queueName: `partvault-${stage}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const WORKER_TIMEOUT = cdk.Duration.minutes(5);
    const queue = new sqs.Queue(this, "ProcessingQueue", {
      queueName: `partvault-${stage}-processing`,
      visibilityTimeout: cdk.Duration.minutes(30),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // Cognito
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `partvault-${stage}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const adminGroup = new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "admin",
    });
    const engineerGroup = new cognito.CfnUserPoolGroup(this, "EngineerGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "engineer",
    });
    const viewerGroup = new cognito.CfnUserPoolGroup(this, "ViewerGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "viewer",
    });

    const client = new cognito.UserPoolClient(this, "WebClient", {
      userPool,
      generateSecret: false,
      authFlows: { pkce: true, custom: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        redirectUrls: ["http://localhost:5173/*", "https://*/*"],
        logoutUrls: ["http://localhost:5173/*"],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    const domain = new cognito.UserPoolDomain(this, "UserPoolDomain", {
      userPool,
      cognitoDomain: { domainPrefix: `partvault-${stage}-${this.account}` },
    });

    // Worker Lambda
    const worker = new lambda.Function(this, "WorkerFn", {
      functionName: `partvault-${stage}-worker`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(assetPath("services", "worker", "dist")),
      timeout: WORKER_TIMEOUT,
      memorySize: 1024,
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: uploadsBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: "partvault-worker",
        POWERTOOLS_LOG_LEVEL: "INFO",
      },
      tracing: lambda.Tracing.ACTIVE,
    });
    table.grantReadWriteData(worker);
    uploadsBucket.grantReadWrite(worker);
    queue.grantConsumeMessages(worker);
    dlq.grantConsumeMessages(worker);

    worker.addEventSource(new lambdaEventSourceSqs(queue));

    // S3 ObjectCreated (uploads/ prefix) -> SQS
    uploadsBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3notifications.SqsDestination(queue), {
      prefix: "uploads/",
    });

    // API Lambda
    const api = new lambda.Function(this, "ApiFn", {
      functionName: `partvault-${stage}-api`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(assetPath("services", "api", "dist")),
      timeout: cargolambdaTimeout(),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: uploadsBucket.bucketName,
        USER_POOL_ID: userPool.userPoolId,
        POWERTOOLS_SERVICE_NAME: "partvault-api",
        POWERTOOLS_LOG_LEVEL: "INFO",
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    table.grantReadWriteData(api);
    uploadsBucket.grantReadWrite(api);

    const authorizer = new authorizers.HttpJwtAuthorizer(
      "JwtAuth",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [client.userPoolClientId],
      },
    );

    const httpApi = new apigwv2.HttpApi(this, "Api", {
      apiName: `partvault-${stage}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.DELETE, apigwv2.CorsHttpMethod.PATCH, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      },
    });

    const integration = new integrations.HttpLambdaIntegration("ApiIntegration", api);
    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE, apigwv2.HttpMethod.PATCH],
      integration,
      authorizer,
    });

    // Web hosting
    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: `partvault-${stage}-web-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const oac = new cloudfront.S3OriginAccessControl(this, "OAC", {
      originAccessControlName: `partvault-${stage}-oac`,
    });

    const dist = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket, { originAccessControl: oac }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        { httpStatus: 403, responsePagePath: "/index.html", responseHttpStatus: 200 },
        { httpStatus: 404, responsePagePath: "/index.html", responseHttpStatus: 200 },
      ],
    });

    new s3deploy.BucketDeployment(this, "WebDeploy", {
      sources: [s3deploy.Source.asset(assetPath("apps", "web", "dist"))],
      destinationBucket: webBucket,
      distribution: dist,
      distributionPaths: ["/*"],
    });

    // Observability: SNS topic for alarms
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `partvault-${stage}-alarms`,
    });
    const alarmEmail = process.env.ALARM_EMAIL ?? "";
    if (alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
    }

    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `PartVault-${stage}`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API Gateway: Requests, Latency & 5xx",
        left: [httpApi.metricCount(), httpApi.metricServerError()],
        right: [httpApi.metricLatency()],
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda: API & Worker Duration & Errors",
        left: [api.metricErrors(), worker.metricErrors()],
        right: [api.metricDuration(), worker.metricDuration()],
      }),
      new cloudwatch.GraphWidget({
        title: "SQS: Queue Depth & Message Age",
        left: [queue.metricApproximateNumberOfMessagesVisible()],
        right: [queue.metricApproximateAgeOfOldestMessage()],
      }),
      new cloudwatch.GraphWidget({
        title: "SQS: DLQ Depth",
        left: [dlq.metricApproximateNumberOfMessagesVisible()],
      }),
    );

    // Budget alert $10/month
    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: `partvault-${stage}-budget`,
        budgetType: "COST",
        budgetLimit: {
          amount: 10,
          unit: "USD",
        },
        timeUnit: "MONTHLY",
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: alarmEmail ? [{ subscriptionType: "EMAIL", address: alarmEmail }] : [],
        },
      ],
    });

    // Alarms
    new cloudwatch.Alarm(this, "DLQAlarm", {
      alarmName: `PartVault-${stage}-DLQDepth`,
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    }).addAlarmAction(new actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, "Api5xxAlarm", {
      alarmName: `PartVault-${stage}-Api5xxRate`,
      metric: httpApi.metricServerError({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
    }).addAlarmAction(new actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, "WorkerErrorsAlarm", {
      alarmName: `PartVault-${stage}-WorkerErrors`,
      metric: worker.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    }).addAlarmAction(new actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, "OldMessageAgeAlarm", {
      alarmName: `PartVault-${stage}-OldMessageAge`,
      metric: queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(5) }),
      threshold: 300,
      evaluationPeriods: 1,
    }).addAlarmAction(new actions.SnsAction(alarmTopic));

    // Outputs
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "WebUrl", { value: `https://${dist.distributionDomainName}` });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "WebClientId", { value: client.userPoolClientId });
    new cdk.CfnOutput(this, "CognitoDomain", { value: domain.domainName });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "UploadsBucketName", { value: uploadsBucket.bucketName });
    new cdk.CfnOutput(this, "QueueUrl", { value: queue.queueUrl });
    new cdk.CfnOutput(this, "AlarmTopicArn", { value: alarmTopic.topicArn });
  }
}

function cargolambdaTimeout(): cdk.Duration {
  return cdk.Duration.seconds(30);
}

import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
function lambdaEventSourceSqs(queue: sqs.Queue) {
  return new lambdaEventSources.SqsEventSource(queue, {
    batchSize: 5,
    reportBatchItemFailures: true,
  });
}
