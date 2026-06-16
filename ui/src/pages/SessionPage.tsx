import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type AuthConfigState,
  fetchAuthConfig,
  fetchSessionToken,
  saveAuthVar,
  type SessionTokenResult,
} from "../api";
import { Alert, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, FIELD_CLASS, OpenPathButton, PageHeading, Tooltip } from "../components";
import { useToast } from "../toast";

/**
 * Session page — fetch a JWT from the environment's IdP (a ForgeRock/PingAM-style
 * challenge/response login) with one click, then view/copy it or save it into
 * ~/.rubato/.env as a `${VAR}` for automations & pipelines. URLs/headers live in
 * config.auth; credentials in ~/.rubato/.env (or typed here for a one-off).
 */
export function SessionPage() {
  const { notify } = useToast();
  const qc = useQueryClient();
  const { data: cfg, isLoading } = useQuery({ queryKey: ["auth-config"], queryFn: fetchAuthConfig });

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<SessionTokenResult | null>(null);

  const fetchToken = useMutation({
    mutationFn: (force: boolean) =>
      fetchSessionToken({ force, username: username.trim() || undefined, password: password || undefined }),
    onSuccess: (r) => {
      setResult(r);
      notify("Got session token", "success");
      qc.invalidateQueries({ queryKey: ["auth-config"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "login failed", "error"),
  });

  const shown = result ?? cfg?.cached ?? null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto">
      <PageHeading
        title="Session"
        actions={
          <>
            <Tooltip
              multiline
              content="Logs in to the configured IdP and fetches a fresh JWT, reusing a still-valid cached token if there is one. You can then view, copy, or save it to ~/.rubato/.env for automations."
            >
              <button
                type="button"
                onClick={() => fetchToken.mutate(false)}
                disabled={!cfg?.configured || fetchToken.isPending}
                className={BTN_PRIMARY_CLASS}
              >
                {fetchToken.isPending ? "Fetching…" : "Get session token"}
              </button>
            </Tooltip>
            <Tooltip
              multiline
              content="Ignores any cached token and performs a full login to mint a brand-new JWT — use this when the cached token is stale or you need to re-authenticate."
            >
              <button
                type="button"
                onClick={() => fetchToken.mutate(true)}
                disabled={!cfg?.configured || fetchToken.isPending}
                className={BTN_GHOST_CLASS}
              >
                Force refresh
              </button>
            </Tooltip>
          </>
        }
      />

      {isLoading ? (
        <p className="text-gray-400">loading…</p>
      ) : (
        <>
          <ConfigSummary cfg={cfg} />
          {cfg?.configured && (
            <Credentials
              cfg={cfg}
              username={username}
              password={password}
              onUsername={setUsername}
              onPassword={setPassword}
            />
          )}
          {shown && <TokenView result={shown} fresh={result !== null} />}
        </>
      )}
    </div>
  );
}

function ConfigSummary({ cfg }: { cfg: AuthConfigState | undefined }) {
  if (!cfg) return null;
  if (!cfg.configured) {
    return (
      <Alert tone="warning" title="Not configured yet">
        <p>
          Add an <code className="font-mono">auth</code> block to <code className="font-mono">~/.rubato/config.json</code>
          <OpenPathButton path="~/.rubato/config.json" />:
        </p>
        <pre className="mt-2 overflow-auto rounded bg-amber-100/60 p-2 font-mono text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">{`"auth": {
  "authUrl": "https://idp.example.com/auth/json/realms/.../authenticate",
  "tokenUrl": "https://app.example.com/api/settings",
  "headers": { "Accept-API-Version": "resource=2.0, protocol=1.0" }
}`}</pre>
        <p className="mt-2">
          Then set <code className="font-mono">{cfg.usernameEnv}</code> and <code className="font-mono">{cfg.passwordEnv}</code> in{" "}
          <code className="font-mono">~/.rubato/.env</code>
          <OpenPathButton path="~/.rubato/.env" /> (or enter them below per-fetch).
        </p>
      </Alert>
    );
  }
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs dark:border-gray-800 dark:bg-gray-900">
      <Row label="Auth URL" value={cfg.authUrl ?? ""} />
      <Row label="Token URL" value={cfg.tokenUrl ?? ""} />
      <Row
        label="Credentials"
        value={
          cfg.hasCredentials
            ? `using ${cfg.usernameEnv} / ${cfg.passwordEnv} from ~/.rubato/.env`
            : `no ${cfg.usernameEnv}/${cfg.passwordEnv} in .env — enter them below`
        }
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-24 shrink-0 text-gray-400">{label}</span>
      <span className="break-all font-mono text-gray-700 dark:text-gray-300">{value}</span>
    </div>
  );
}

function Credentials({
  cfg,
  username,
  password,
  onUsername,
  onPassword,
}: {
  cfg: AuthConfigState;
  username: string;
  password: string;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <p className="mb-2 text-xs text-gray-500">
        {cfg.hasCredentials
          ? "Optional — leave blank to use the saved credentials, or type to override for one fetch (never stored)."
          : "Enter credentials for this fetch (never stored). Add them to ~/.rubato/.env to skip this."}
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={username}
          onChange={(e) => onUsername(e.target.value)}
          placeholder="username"
          autoComplete="off"
          className={`${FIELD_CLASS} min-w-48 flex-1`}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          placeholder="password"
          autoComplete="new-password"
          className={`${FIELD_CLASS} min-w-48 flex-1`}
        />
      </div>
    </div>
  );
}

function TokenView({ result, fresh }: { result: SessionTokenResult; fresh: boolean }) {
  const { notify } = useToast();
  const [reveal, setReveal] = useState(false);
  const [varName, setVarName] = useState("SESSION_JWT");

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`Copied ${what}`, "success");
    } catch {
      notify("Copy failed", "error");
    }
  };

  const save = useMutation({
    mutationFn: () => saveAuthVar(varName.trim(), result.token),
    onSuccess: (r) => notify(`Saved to ~/.rubato/.env as ${r.name} — use it as \${${r.name}}`, "success"),
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const exp = result.expiresAt ? new Date(result.expiresAt) : null;
  const expired = result.expiresAt ? result.expiresAt < Date.now() : false;
  const sub = result.claims?.sub;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">Session token</span>
        {!fresh && <span className="text-xs text-gray-400">(cached)</span>}
        <span className="ml-auto text-xs text-gray-400">fetched {new Date(result.fetchedAt).toLocaleTimeString()}</span>
      </div>

      <div className="mb-2 flex flex-wrap gap-3 text-xs text-gray-500">
        {sub != null && (
          <span>
            sub <span className="font-mono text-gray-700 dark:text-gray-300">{String(sub)}</span>
          </span>
        )}
        {exp && (
          <span className={expired ? "text-red-500" : ""}>
            {expired ? "expired" : "expires"} <span className="font-mono">{exp.toLocaleString()}</span>
          </span>
        )}
      </div>

      <div className="flex items-start gap-2">
        <textarea
          readOnly
          value={reveal ? result.token : maskToken(result.token)}
          rows={3}
          className={`min-h-0 flex-1 resize-none font-mono text-xs ${FIELD_CLASS}`}
        />
        <div className="flex flex-col gap-1">
          <Tooltip
            multiline
            content="Shows or masks the full JWT. It's hidden by default (only the head and tail are shown) so the secret isn't exposed on screen."
          >
            <button type="button" onClick={() => setReveal((r) => !r)} className={`${BTN_GHOST_CLASS} text-xs`}>
              {reveal ? "Hide" : "Reveal"}
            </button>
          </Tooltip>
          <Tooltip
            multiline
            content="Copies the full JWT to your clipboard (even while it's masked on screen) so you can paste it into a request or tool."
          >
            <button type="button" onClick={() => copy(result.token, "token")} className={`${BTN_GHOST_CLASS} text-xs`}>
              Copy
            </button>
          </Tooltip>
        </div>
      </div>

      {result.cookieHeader && (
        <div className="mt-2">
          <Tooltip
            multiline
            content="Copies the full Cookie header value from the login response, for endpoints that authenticate via a session cookie instead of a Bearer token."
          >
            <button
              type="button"
              onClick={() => copy(result.cookieHeader, "cookie")}
              className={`${BTN_GHOST_CLASS} text-xs`}
            >
              Copy session cookie
            </button>
          </Tooltip>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
        <span className="text-xs text-gray-500">Save to ~/.rubato/.env as</span>
        <OpenPathButton path="~/.rubato/.env" />
        <input
          value={varName}
          onChange={(e) => setVarName(e.target.value)}
          className={`${FIELD_CLASS} w-40 font-mono text-xs`}
          placeholder="SESSION_JWT"
        />
        <Tooltip
          multiline
          content="Writes this token into ~/.rubato/.env under the variable name on the left, so automations and pipelines can reference it as ${NAME} without re-fetching. Stores the secret on disk in plaintext."
        >
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!varName.trim() || save.isPending}
            className={BTN_PRIMARY_CLASS}
          >
            {save.isPending ? "Saving…" : "Save as variable"}
          </button>
        </Tooltip>
        <span className="text-xs text-gray-400">→ reference it as ${`{${varName.trim() || "VAR"}}`} in automations/pipelines</span>
      </div>
    </div>
  );
}

/** Show the head/tail of a token so it's recognizable without exposing it fully. */
function maskToken(token: string): string {
  if (token.length <= 24) return "•".repeat(token.length);
  return `${token.slice(0, 12)}…${token.slice(-8)}`;
}
