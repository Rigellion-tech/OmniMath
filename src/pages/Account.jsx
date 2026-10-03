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
      <div className="omni-panel rounded-2xl border-0 bg-transparent p-6 shadow-none">
        <div className="flex items-start gap-4">
          {user?.imageUrl ? (
            <img
              src={user.imageUrl}
              alt=""
              className="h-14 w-14 rounded-2xl border border-neutral-200 object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100">
              <UserRound className="h-6 w-6 text-neutral-600" />
            </div>
          )}
          <div className="min-w-0">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              Account
            </p>
            <h1 className="mt-1 truncate text-2xl font-semibold text-neutral-950">{name}</h1>
            <p className="mt-1 truncate text-sm text-neutral-500">{email}</p>
          </div>
        </div>
      </div>

      <div className="omni-panel rounded-2xl border-0 bg-transparent p-6 shadow-none">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-neutral-50 p-4">
            <Mail className="h-4 w-4 text-neutral-500" />
            <p className="mt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              Primary email
            </p>
            <p className="mt-1 truncate text-sm text-neutral-800">{email}</p>
          </div>
          <div className="rounded-2xl bg-neutral-50 p-4">
            <ShieldCheck className="h-4 w-4 text-neutral-500" />
            <p className="mt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              Usage identity
            </p>
            <p className="mt-1 truncate text-sm text-neutral-800">{user?.id}</p>
          </div>
          <div className="rounded-2xl bg-neutral-50 p-4">
            {profileStatus === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
            ) : (
              <Database className="h-4 w-4 text-neutral-500" />
            )}
            <p className="mt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              Stored profile
            </p>
            <p className="mt-1 truncate text-sm text-neutral-800">
              {persistedUser?.tier ? `${persistedUser.tier} account` : "Sync pending"}
            </p>
          </div>
        </div>
        {profileError && (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
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
