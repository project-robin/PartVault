import * as cdk from "aws-cdk-lib";
import { PartVaultStack } from "../lib/partvault-stack.js";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "ap-south-1",
};

const stage = process.env.STAGE ?? "dev";

new PartVaultStack(app, `PartVault-${stage}`, {
  env,
  stage,
  description: `PartVault ${stage} stack`,
});

app.synth();
