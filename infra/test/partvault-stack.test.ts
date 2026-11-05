import { describe, test, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PartVaultStack } from "../lib/partvault-stack.js";

describe("PartVaultStack", () => {
  const template = Template.fromStack(new PartVaultStack(
    new cdk.App(),
    "TestStack",
    { stage: "test", env: { account: "123456789012", region: "ap-south-1" } },
  ));

  test("creates DynamoDB table with PAY_PER_REQUEST", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
    });
  });

  test("creates private S3 bucket with versioning and multipart abort rule", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      VersioningConfiguration: { Status: "Enabled" },
      LifecycleConfiguration: { Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: "Enabled" }] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  test("creates SQS queue with DLQ maxReceiveCount 3", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: { maxReceiveCount: 3 },
    });
  });

  test("creates Cognito user pool with PKCE client", () => {
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  });

  test("creates worker Lambda with partial batch failure", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "handler.handler",
      Runtime: "nodejs22.x",
      TracingConfig: { Mode: "Active" },
    });
  });

  test("creates API Gateway HttpApi with JWT authorizer", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  });

  test("creates CloudFront distribution with OAC", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  test("creates $10 budget", () => {
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetLimit: { Amount: 10, Unit: "USD" },
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
      },
    });
  });

  test("creates alarms for DLQ, API 5xx, worker errors, message age", () => {
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
  });
});
