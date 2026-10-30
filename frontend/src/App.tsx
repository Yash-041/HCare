import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppProvider } from "./app/AppContext";
import { TopBar } from "./components/StatusBar";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { CapturePage } from "./pages/CapturePage";
import { ConflictPage } from "./pages/ConflictPage";
import { ConsultationPage } from "./pages/ConsultationPage";
import { LoginPage } from "./pages/LoginPage";
import { PatientPage } from "./pages/PatientPage";
import { PatientsPage } from "./pages/PatientsPage";
import { SyncPage } from "./pages/SyncPage";

/** Remount per patient so form state never leaks between records. */
function PatientRoute() {
  const { id } = useParams();
  return <PatientPage key={id ?? "new"} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <UpdatePrompt />
      <AppProvider signedOut={(signIn) => <LoginPage signIn={signIn} />}>
        <TopBar />
        <Routes>
          <Route path="/" element={<PatientsPage />} />
          <Route path="/patients/new" element={<PatientRoute />} />
          <Route path="/patients/:id" element={<PatientRoute />} />
          <Route path="/patients/:id/capture" element={<CapturePage />} />
          <Route path="/patients/:id/consultations/:cid" element={<ConsultationPage />} />
          <Route path="/sync" element={<SyncPage />} />
          <Route path="/sync/conflicts/:id" element={<ConflictPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  );
}
