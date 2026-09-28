import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorBox, Field, Input } from '../components/ui';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password, ...(needsCode ? { code } : {}) });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ADMIN_2FA_REQUIRED') setNeedsCode(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  const blocked = error instanceof ApiError && error.status === 429;
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-panel p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold">Panel de tenancy</h1>
          <p className="text-sm text-muted">Inicia sesión para administrar los tenants.</p>
        </div>
        {blocked ? (
          <div
            role="alert"
            className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
          >
            Demasiados intentos fallidos. Espera unos minutos antes de volver a intentar.
          </div>
        ) : (
          <ErrorBox error={error} />
        )}
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Contraseña">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {needsCode && (
          <Field label="Código de verificación" hint="Los 6 dígitos de tu app de autenticación.">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" busy={busy} className="w-full">
          {needsCode ? 'Verificar' : 'Entrar'}
        </Button>
      </form>
    </main>
  );
}
