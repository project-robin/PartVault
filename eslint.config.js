import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.cdk.out/**",
      "cdk.out/**",
      "**/*.d.ts",
      "**/coverage/**",
    ],
  },
  prettier,
];
