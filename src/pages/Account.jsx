import React from "react";
import { Mail, ShieldCheck, UserRound } from "lucide-react";
import { useUser } from "@clerk/react";

export default function Account() {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress || "No primary email";
  const name = user?.fullName || user?.username || "OmniMath user";

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
        <div className="grid gap-3 sm:grid-cols-2">
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
        </div>
      </div>
    </section>
  );
}
