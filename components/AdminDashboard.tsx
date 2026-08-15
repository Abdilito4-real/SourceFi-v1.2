"use client";

// components/AdminDashboard.tsx
//
// Real route (/admin) — Overview, Applications, Users. Only reachable if
// the server-verified role allows it (see the redirect guard below); same
// as BuyerDashboard/SourcerDashboard, the route existing doesn't grant
// anything — every write here is its own requireRole(["admin"]) check
// server-side (see app/api/admin/*), this is UX only.
//
// This is the one screen in the app that can turn a sourcer_applications
// row into an actual role change — see CLAUDE.md: "Sourcer role is
// granted by an admin after vetting. A user cannot self-assign it."
import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Info, LayoutGrid, ClipboardList, Users as UsersIcon, Check, X, ShieldCheck, UserCog } from "lucide-react";

import { useSession } from "./SessionProvider";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import StatCard from "./ui/StatCard";
import Badge, { type BadgeTone } from "./ui/Badge";
import Button from "./ui/Button";
import Select from "./ui/Select";
import { Table, Thead, Tbody, Tr, Th, Td } from "./ui/Table";
import { useToast } from "./ui/Toast";
import type { AdminUserRow, ApplicationStatus, Role, SourcerApplicationRow } from "../lib/types";

type Section = "overview" | "applications" | "users";

const ROLE_TONE: Record<Role, BadgeTone> = {
  buyer: "neutral",
  sourcer: "accent",
  admin: "success",
};

const ALL_ROLES: Role[] = ["buyer", "sourcer", "admin"];

export default function AdminDashboard() {
  const router = useRouter();
  const { notify } = useToast();
  const { checkingSession, user, signingOut, handleSignOut } = useSession();

  const [section, setSection] = useState<Section>("overview");

  const [applications, setApplications] = useState<SourcerApplicationRow[]>([]);
  const [applicationsStatus, setApplicationsStatus] = useState<ApplicationStatus>("pending");
  const [loadingApplications, setLoadingApplications] = useState(true);
  const [reviewingId, setReviewingId] = useState<number | null>(null);

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [changingRoleId, setChangingRoleId] = useState<number | null>(null);

  const isAdmin = user?.role === "admin";

  // Deep-link guard, same pattern as SourcerDashboard's canBeSourcer check
  // — a UX nicety, not the security boundary. Every actual read/write below
  // is independently requireRole(["admin"])-checked server-side.
  useEffect(() => {
    if (checkingSession) return;
    if (!user) {
      router.replace("/");
      return;
    }
    if (!isAdmin) {
      router.replace("/buyer");
    }
  }, [checkingSession, user, isAdmin, router]);

  const loadApplications = useCallback(
    async (status: ApplicationStatus) => {
      setLoadingApplications(true);
      try {
        const res = await fetch(`/api/admin/sourcer-applications?status=${status}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load applications.");
        setApplications(data.applications || []);
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Failed to load applications.");
      } finally {
        setLoadingApplications(false);
      }
    },
    [notify]
  );

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load users.");
      setUsers(data.users || []);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to load users.");
    } finally {
      setLoadingUsers(false);
    }
  }, [notify]);

  useEffect(() => {
    if (!isAdmin) return;
    loadApplications(applicationsStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, applicationsStatus]);

  useEffect(() => {
    if (!isAdmin) return;
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const handleReview = async (application: SourcerApplicationRow, action: "approve" | "reject") => {
    setReviewingId(application.id);
    try {
      const res = await fetch(`/api/admin/sourcer-applications/${application.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to review application.");
      setApplications((rows) => rows.filter((r) => r.id !== application.id));
      notify(
        "success",
        action === "approve"
          ? `${application.applicant_username ? "@" + application.applicant_username : application.applicant_email} is now a sourcer.`
          : "Application rejected."
      );
      // The applicant's row in the Users table just changed role — refetch
      // rather than patch it in place so Users stays trustworthy even if
      // it's never been opened yet this session.
      if (action === "approve") loadUsers();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to review application.");
    } finally {
      setReviewingId(null);
    }
  };

  const handleRoleChange = async (target: AdminUserRow, nextRole: Role) => {
    if (nextRole === target.role) return;
    setChangingRoleId(target.id);
    try {
      const res = await fetch(`/api/admin/users/${target.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to change role.");
      setUsers((rows) => rows.map((u) => (u.id === target.id ? { ...u, role: nextRole } : u)));
      notify("success", `${target.username ? "@" + target.username : target.email} is now ${nextRole}.`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to change role.");
    } finally {
      setChangingRoleId(null);
    }
  };

  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", icon: <LayoutGrid size={16} />, active: section === "overview", onClick: () => setSection("overview") },
    {
      key: "applications",
      label: "Applications",
      icon: <ClipboardList size={16} />,
      active: section === "applications",
      onClick: () => setSection("applications"),
      badge: applicationsStatus === "pending" ? applications.length : undefined,
    },
    { key: "users", label: "Users", icon: <UsersIcon size={16} />, active: section === "users", onClick: () => setSection("users") },
  ];

  if (checkingSession || !user || !isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <Loader2 size={22} className="spin-icon text-accent" aria-label="Loading" />
      </div>
    );
  }

  const switchLinks: SwitchLink[] = [
    { label: "Switch to buyer dashboard", href: "/buyer" },
    { label: "Switch to sourcer dashboard", href: "/sourcer" },
  ];

  const sourcerCount = users.filter((u) => u.role === "sourcer").length;
  const buyerCount = users.filter((u) => u.role === "buyer").length;

  return (
    <DashboardShell
      activeDashboard="admin"
      switchLinks={switchLinks}
      navItems={navItems}
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      pageTitle={section === "overview" ? "Admin overview" : section === "applications" ? "Sourcer applications" : "Users"}
      pageSubtitle={
        section === "overview"
          ? "Vet sourcing partners and manage account access."
          : section === "applications"
          ? "Review who's applying to become a sourcing partner."
          : "Every account on SourceFi and its current role."
      }
    >
      {section === "overview" && (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Pending applications"
              value={applicationsStatus === "pending" ? applications.length : "—"}
              icon={<ClipboardList size={16} />}
              tone="accent"
              hint={applicationsStatus === "pending" ? undefined : "Switch to Applications to view"}
            />
            <StatCard label="Sourcers" value={loadingUsers ? "—" : sourcerCount} icon={<ShieldCheck size={16} />} />
            <StatCard label="Buyers" value={loadingUsers ? "—" : buyerCount} icon={<UsersIcon size={16} />} />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-xl italic text-text-primary">Pending applications</h2>
              <button type="button" onClick={() => setSection("applications")} className="text-sm font-semibold text-accent-text hover:underline">
                View all
              </button>
            </div>
            {loadingApplications ? (
              <div className="flex justify-center py-10">
                <Loader2 size={22} className="spin-icon text-accent" />
              </div>
            ) : applications.length === 0 ? (
              <EmptyState message="No pending applications right now." />
            ) : (
              <div className="grid gap-3">
                {applications.slice(0, 3).map((a) => (
                  <ApplicationCard key={a.id} application={a} reviewing={reviewingId === a.id} onReview={handleReview} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {section === "applications" && (
        <div>
          <div className="mb-5 flex w-fit rounded-lg border border-border bg-surface p-1">
            {(["pending", "approved", "rejected"] as ApplicationStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setApplicationsStatus(s)}
                className={`rounded-md px-3.5 py-1.5 text-xs font-semibold capitalize transition-colors duration-base ease-base ${
                  applicationsStatus === s ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {loadingApplications ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : applications.length === 0 ? (
            <EmptyState message={`No ${applicationsStatus} applications.`} />
          ) : (
            <div className="grid gap-3">
              {applications.map((a) => (
                <ApplicationCard
                  key={a.id}
                  application={a}
                  reviewing={reviewingId === a.id}
                  onReview={applicationsStatus === "pending" ? handleReview : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {section === "users" && (
        <div>
          {loadingUsers ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : users.length === 0 ? (
            <EmptyState message="No users found." />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>User</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Joined</Th>
                  <Th>Change role</Th>
                </Tr>
              </Thead>
              <Tbody>
                {users.map((u) => (
                  <Tr key={u.id}>
                    <Td className="font-semibold">{u.username ? `@${u.username}` : "—"}</Td>
                    <Td className="text-text-secondary">{u.email}</Td>
                    <Td>
                      <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>
                    </Td>
                    <Td className="text-text-secondary">{new Date(u.created_at).toLocaleDateString()}</Td>
                    <Td>
                      {u.email === user.identity ? (
                        <span className="text-xs text-text-tertiary">This is you</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Select
                            value={u.role}
                            disabled={changingRoleId === u.id}
                            onChange={(e) => handleRoleChange(u, e.target.value as Role)}
                            className="w-32 py-1.5 text-xs"
                          >
                            {ALL_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </Select>
                          {changingRoleId === u.id && <Loader2 size={14} className="spin-icon text-accent" />}
                        </div>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </div>
      )}
    </DashboardShell>
  );
}

function ApplicationCard({
  application,
  reviewing,
  onReview,
}: {
  application: SourcerApplicationRow;
  reviewing: boolean;
  onReview?: (application: SourcerApplicationRow, action: "approve" | "reject") => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <UserCog size={15} className="text-text-tertiary" />
            <span className="font-semibold text-text-primary">
              {application.applicant_username ? `@${application.applicant_username}` : application.applicant_email}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-text-tertiary">{application.applicant_email}</div>
        </div>
        <span className="text-xs text-text-tertiary">{new Date(application.created_at).toLocaleDateString()}</span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Location</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{application.location || "Not specified"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Experience</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{application.experience || "Not specified"}</dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Reason</dt>
          <dd className="mt-0.5 text-sm leading-relaxed text-text-primary">{application.reason || "Not specified"}</dd>
        </div>
      </dl>

      {onReview && (
        <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
          <Button size="sm" variant="primary" loading={reviewing} onClick={() => onReview(application, "approve")}>
            <Check size={14} /> Approve
          </Button>
          <Button size="sm" variant="secondary" disabled={reviewing} onClick={() => onReview(application, "reject")}>
            <X size={14} /> Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[10px] border-[1.5px] border-dashed border-border bg-surface px-5 py-10 text-center">
      <Info size={24} className="mx-auto mb-2 text-text-tertiary" />
      <p className="mx-auto max-w-[320px] text-sm text-text-secondary">{message}</p>
    </div>
  );
}
