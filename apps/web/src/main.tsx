import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Amplify } from "aws-amplify";
import App from "./App";
import "./index.css";

const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const userPoolId = import.meta.env.VITE_USER_POOL_ID as string | undefined;
const region = import.meta.env.VITE_AWS_REGION as string | undefined;
const domain = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;

if (clientId && userPoolId) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId: clientId,
        ...(domain
          ? {
              loginWith: {
                oauth: {
                  domain,
                  scopes: ["openid", "email", "profile"],
                  redirectSignIn: [window.location.origin],
                  redirectSignOut: [window.location.origin],
                  responseType: "code",
                },
              },
            }
          : {}),
      },
    },
  });
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
