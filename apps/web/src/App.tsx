import { Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { PartsListPage } from "./pages/PartsListPage";
import { PartDetailPage } from "./pages/PartDetailPage";
import { ProtectedRoute } from "./components/ProtectedRoute";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <PartsListPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/parts/:partNumber"
        element={
          <ProtectedRoute>
            <PartDetailPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
