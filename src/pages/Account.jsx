import React, { useEffect, useState } from "react";
import { AlertTriangle, Database, Loader2, Mail, ShieldCheck, UserRound } from "lucide-react";
import { useUser } from "@clerk/react";
import { syncCurrentUser } from "@/api/userClient";
import { isMockAuthMode, useAuthToken } from "@/lib/auth";

function AccountContent({ user, syncEnabled = true }) {
  const { getToken } = useAuthToken();
  const [profileRecord, setProfileRecord] = useState(null);
  const [profileStatus, setProfileStatus] = useState("idle");
  const [profileError, setProfileError] = useState("");
  const email = user?.primaryEmailAddress?.emailAddress || "No primary email";
  const name = user?.fullName || user?.username || "OmniMath user";
  const persistedUser = profileRecord?.user;

  useEffect(() => {
    if (!user || !syncEnabled) {
      if (user && !syncEnabled) {
        setProfileStatus("ready");
        setProfileRecord({ user: { tier: "mock", id: user.id } });
      }
      return undefined;
    }

    let cancelled = false;
    setProfileStatus("loading");
    setProfileError("");

    syncCurrentUser({
      getToken,
      profile: {
        email: user.primaryEmailAddress?.emailAddress,
        displayName: user.fullName || user.username,
        imageUrl: user.imageUrl,
      },
    })
      .then((data) => {
        if (cancelled) return;
        setProfileRecord(data);
        setProfileStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setProfileError(error.message || "Could not sync your profile.");
        setProfileStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [getToken, syncEnabled, user]);

  return (
    <section className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="omni-panel rounded-2xl p-6">
        <div className="flex items-start gap-4">
          {user?.imageUrl ? (
            <img
              src={user.imageUrl}
              alt=""
              className="h-14 w-14 rounded-2xl border border-teal-300/20 object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-teal-300/20 bg-teal-300/10">
              <UserRound className="h-6 w-6 text-teal-200" />
            </div>
          )}
          <div className="min-w-0">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/70">
              Account
            </p>
            <h1 className="mt-1 truncate text-2xl font-semibold text-cyan-50">{name}</h1>
            <p className="mt-1 truncate text-sm text-slate-300/60">{email}</p>
          </div>
        </div>
      </div>

      <div className="omni-panel rounded-2xl p-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
            <Mail className="h-4 w-4 text-teal-200/80" />
            <p className="mt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/50">
              Primary email
            </p>
            <p className="mt-1 truncate text-sm text-slate-100/85">{email}</p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
            <ShieldCheck className="h-4 w-4 text-teal-200/80" />
            <p className="mt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/50">
              Usage identity
            </p>
            <p className="mt-1 truncate text-sm text-slate-100/85">{user?.id}</p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
            {profileStatus === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin text-teal-200/80" />
            ) : (
              <Database className="h-4 w-4 text-teal-200/80" />
            )}
            <p className="mt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/50">
              Stored profile
            </p>
            <p className="mt-1 truncate text-sm text-slate-100/85">
              {persistedUser?.tier ? `${persistedUser.tier} account` : "Sync pending"}
            </p>
          </div>
        </div>
        {profileError && (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3 text-sm text-amber-100/80">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{profileError}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ClerkAccount() {
  const { user } = useUser();
  return <AccountContent user={user} />;
}

function MockAccount() {
  const { user } = useAuthToken();
  return <AccountContent user={user} syncEnabled={false} />;
}

export default function Account() {
  if (isMockAuthMode()) return <MockAccount />;
  return <ClerkAccount />;
}
