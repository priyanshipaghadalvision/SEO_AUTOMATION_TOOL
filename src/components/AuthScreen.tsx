import { useState } from "react";
import type { FormEvent } from "react";
import type { User } from "../api/client";
import { login, register } from "../api/client";
import { GlobeIcon, SpinnerIcon } from "./icons";
import "./AuthScreen.css";

const MIN_PASSWORD_LENGTH = 12;

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === "register";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { user } = isRegister
        ? await register(email, password, name || undefined)
        : await login(email, password);
      onAuthenticated(user);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Something went wrong.";
      // The API returns machine-readable codes; translate the ones a user
      // can actually act on rather than showing "invalid_credentials".
      setError(
        raw === "invalid_credentials"
          ? "Incorrect email or password."
          : raw === "email_taken"
            ? "An account with that email already exists."
            : raw,
      );
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode() {
    setMode(isRegister ? "login" : "register");
    setError(null);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">SEO</span>
          <div>
            <h1>Autonomous SEO Platform</h1>
            <p className="subtitle">{isRegister ? "Create your account" : "Sign in to continue"}</p>
          </div>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegister && (
            <label className="auth-field">
              <span>Name <span className="auth-optional">(optional)</span></span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                autoComplete="name"
              />
            </label>
          )}

          <label className="auth-field">
            <span>Email</span>
            <div className="auth-input-icon">
              <GlobeIcon />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                autoComplete="email"
                placeholder="you@company.com"
              />
            </div>
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              required
              minLength={isRegister ? MIN_PASSWORD_LENGTH : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder={isRegister ? `At least ${MIN_PASSWORD_LENGTH} characters` : ""}
            />
            {isRegister && (
              <span className="auth-hint">
                {password.length > 0 && password.length < MIN_PASSWORD_LENGTH
                  ? `${MIN_PASSWORD_LENGTH - password.length} more character${
                      MIN_PASSWORD_LENGTH - password.length === 1 ? "" : "s"
                    } needed`
                  : `Minimum ${MIN_PASSWORD_LENGTH} characters. Length beats complexity.`}
              </span>
            )}
          </label>

          {error && <p className="error-text auth-error">{error}</p>}

          <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
            {submitting ? (
              <>
                <SpinnerIcon /> {isRegister ? "Creating account…" : "Signing in…"}
              </>
            ) : isRegister ? (
              "Create account"
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? "Already have an account?" : "No account yet?"}{" "}
          <button type="button" className="link-button" onClick={switchMode} disabled={submitting}>
            {isRegister ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </div>
  );
}
