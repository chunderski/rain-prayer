import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import type { ApiClient } from "./api/client";
import { AppShell, OfflineBanner } from "./components/AppShell";
import { Loading } from "./components/ui";
import { SignIn } from "./screens/SignIn";
import { AssessmentDetail, AssessmentsHome } from "./screens/Assessments";
import { ClientDetail, ClientsList } from "./screens/Clients";
import { NewAssessment } from "./screens/NewAssessment";
import { ControlDetailScreen, Library } from "./screens/Library";

function Gate() {
  const { status } = useAuth();
  if (status === "loading") return <Loading label="Starting Sentinel Assess" />;
  if (status === "signed_out")
    return (
      <>
        <OfflineBanner />
        <SignIn />
      </>
    );
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<AssessmentsHome />} />
        <Route path="assessments/new" element={<NewAssessment />} />
        <Route path="assessments/:id" element={<AssessmentDetail />} />
        <Route path="clients" element={<ClientsList />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="library" element={<Library />} />
        <Route path="library/:controlId" element={<ControlDetailScreen />} />
        <Route path="*" element={<AssessmentsHome />} />
      </Route>
    </Routes>
  );
}

export interface AppProps {
  /**
   * "browser" for the standalone PWA and iframe embeds (owns the URL);
   * "memory" for the <sentinel-assess> web component, so the host page URL is never touched.
   */
  router?: "browser" | "memory";
  initialPath?: string;
  client?: ApiClient;
}

export function App({ router = "browser", initialPath = "/", client }: AppProps) {
  const body = (
    <div className="min-h-dvh bg-bg text-lg text-ink">
      <AuthProvider client={client}>
        <Gate />
      </AuthProvider>
    </div>
  );
  return router === "memory" ? <MemoryRouter initialEntries={[initialPath]}>{body}</MemoryRouter> : <BrowserRouter>{body}</BrowserRouter>;
}
