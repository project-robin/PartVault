import { signInWithRedirect } from "aws-amplify/auth";

export function LoginPage() {
  const handleDemoLogin = (role: "admin" | "engineer" | "viewer") => {
    localStorage.setItem("partvault_token", `demo-${role}-token`);
    localStorage.setItem("partvault_role", role);
    localStorage.setItem("partvault_email", `${role}@demo.local`);
    window.location.href = "/";
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4" role="main">
      <div className="w-full max-w-sm p-6 bg-white border rounded shadow">
        <h1 className="text-2xl font-bold mb-2">PartVault Login</h1>
        <p className="text-sm text-gray-600 mb-6">Sign in with your organisation account.</p>

        <button
          type="button"
          className="w-full bg-blue-600 text-white py-2 rounded font-medium hover:bg-blue-700 transition"
          onClick={() => {
            try {
              signInWithRedirect();
            } catch (err) {
              console.warn("Cognito not configured locally; please use demo sign in below", err);
            }
          }}
        >
          Sign in with Cognito Hosted UI
        </button>

        <div className="mt-6 pt-6 border-t">
          <p className="text-xs text-gray-500 font-medium mb-3 text-center">Demo & Local Quick Sign-In:</p>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className="text-xs bg-gray-100 hover:bg-gray-200 border py-2 px-1 rounded text-center font-medium"
              onClick={() => handleDemoLogin("admin")}
            >
              Admin
            </button>
            <button
              type="button"
              className="text-xs bg-gray-100 hover:bg-gray-200 border py-2 px-1 rounded text-center font-medium"
              onClick={() => handleDemoLogin("engineer")}
            >
              Engineer
            </button>
            <button
              type="button"
              className="text-xs bg-gray-100 hover:bg-gray-200 border py-2 px-1 rounded text-center font-medium"
              onClick={() => handleDemoLogin("viewer")}
            >
              Viewer
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
