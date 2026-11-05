import { type ReactNode } from "react";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const token = localStorage.getItem("partvault_token");
  if (!token) {
    window.location.href = "/login";
    return null;
  }
  return <>{children}</>;
}
