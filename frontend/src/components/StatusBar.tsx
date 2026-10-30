import { Link, NavLink, useNavigate } from "react-router-dom";
import { useApp } from "../app/AppContext";
import { useConnectivity, useSyncBadge } from "../app/hooks";
import type { RecordSyncStatus } from "../lib/types";

const CONNECTIVITY_LABEL = { online: "Online", offline: "Offline", unreachable: "Server unreachable" } as const;
const ROLE_LABEL = { health_worker: "Health worker", doctor: "Doctor", admin: "Admin" } as const;

/** Role-specific sections; patients are reached from the home screen. */
const NAV: Record<keyof typeof ROLE_LABEL, [string, string][]> = {
  admin: [
    ["/admin/users", "Staff"],
    ["/admin/devices", "Devices"],
    ["/admin/audit", "Audit log"],
  ],
  doctor: [
    ["/", "Patients"],
    ["/audit", "Audit log"],
  ],
  health_worker: [["/", "Patients"]],
};

export function TopBar() {
  const { session, signOut, lockNow } = useApp();
  const connectivity = useConnectivity();
  const badge = useSyncBadge();
  const navigate = useNavigate();

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <img src="/icon.svg" alt="" width={28} height={28} />
        HCare
      </Link>
      <nav className="topnav" aria-label="Sections">
        {NAV[session.user.role].map(([to, label]) => (
          <NavLink key={to} to={to} end className={({ isActive }) => (isActive ? "active" : "")}>
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="topbar-status">
        <span className={`conn conn-${connectivity}`} title={CONNECTIVITY_LABEL[connectivity]}>
          <span className="dot" />
          <span className="conn-label">{CONNECTIVITY_LABEL[connectivity]}</span>
        </span>
        <Link to="/sync" className={`badge badge-${badge.kind}`}>
          {badge.label}
        </Link>
      </div>
      <div className="topbar-user">
        <span className="user-name">
          {session.user.full_name || session.user.username} <span className={`role-chip role-${session.user.role}`}>{ROLE_LABEL[session.user.role]}</span>
        </span>
        <button className="link" onClick={lockNow} title="Lock: patient data stays encrypted until the password is entered">
          Lock
        </button>
        <button
          className="link"
          onClick={() => {
            navigate("/");
            void signOut();
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

const CHIP_LABEL: Record<RecordSyncStatus, string> = {
  synced: "Synced",
  pending: "Pending",
  conflict: "Conflict",
  error: "Needs fix",
};

export function SyncChip({ status }: { status: RecordSyncStatus }) {
  return <span className={`chip chip-${status}`}>{CHIP_LABEL[status]}</span>;
}
