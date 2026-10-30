import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppProvider, useApp } from "./app/AppContext";
import { TopBar } from "./components/StatusBar";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { AuditPage } from "./pages/admin/AuditPage";
import { UsersPage } from "./pages/admin/UsersPage";
import { CapturePage } from "./pages/CapturePage";
import { ConflictPage } from "./pages/ConflictPage";
import { ConsultationPage } from "./pages/ConsultationPage";
import { DevicesPage } from "./pages/DevicesPage";
import { LoginPage } from "./pages/LoginPage";
import { PatientPage } from "./pages/PatientPage";
import { PatientsPage } from "./pages/PatientsPage";
import { SyncPage } from "./pages/SyncPage";
import { UnlockPage } from "./pages/UnlockPage";

/** Remount per patient so form state never leaks between records. */
function PatientRoute() {
  const { id } = useParams();
  return <PatientPage key={id ?? "new"} />;
}

/**
 * Each role lands where its work is. Admins manage staff, devices and the audit log; they
 * cannot change clinical records (the server enforces that), so patient screens are not
 * offered to them. Doctors and health workers work with patients.
 */
function RoleRoutes() {
  const { session } = useApp();
  if (session.user.role === "admin") {
    return (
      <Routes>
        <Route path="/admin/users" element={<UsersPage />} />
        <Route path="/admin/devices" element={<DevicesPage />} />
        <Route path="/admin/audit" element={<AuditPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="*" element={<Navigate to="/admin/users" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<PatientsPage />} />
      <Route path="/patients/new" element={<PatientRoute />} />
      <Route path="/patients/:id" element={<PatientRoute />} />
      <Route path="/patients/:id/capture" element={<CapturePage />} />
      <Route path="/patients/:id/consultations/:cid" element={<ConsultationPage />} />
      <Route path="/sync" element={<SyncPage />} />
      <Route path="/sync/conflicts/:id" element={<ConflictPage />} />
      {session.user.role === "doctor" && <Route path="/audit" element={<AuditPage />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <UpdatePrompt />
      <AppProvider
        signedOut={(signIn) => <LoginPage signIn={signIn} />}
        locked={(session, unlock, switchUser) => <UnlockPage session={session} unlock={unlock} switchUser={switchUser} />}
      >
        <TopBar />
        <RoleRoutes />
      </AppProvider>
    </BrowserRouter>
  );
}
