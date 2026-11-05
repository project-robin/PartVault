import { signInWithRedirect } from "aws-amplify/auth";

export function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center" role="main">
      <div className="w-full max-w-sm p-6 border rounded shadow">
        <h1 className="text-2xl font-bold mb-4">PartVault Login</h1>
        <p className="text-sm text-gray-600 mb-4">Sign in with your organisation account.</p>
        <button
          type="button"
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
          onClick={() => signInWithRedirect()}
        >
          Sign in with Cognito
        </button>
      </div>
    </main>
  );
}
