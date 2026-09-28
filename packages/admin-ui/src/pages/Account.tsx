import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { post } from '../api';
import { useAuth } from '../auth';
import { Button, Card, ErrorBox, Field, Input, PageHeader, useToast } from '../components/ui';

export function Account() {
  const { session, refresh } = useAuth();
  const toast = useToast();
  const [passwords, setPasswords] = useState({ current: '', password: '' });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');

  const changePassword = useMutation({
    mutationFn: () => post('/auth/password', passwords),
    onSuccess: () => (
      setPasswords({ current: '', password: '' }),
      toast('Contraseña cambiada; las demás sesiones se cerraron')
    ),
  });
  const start2fa = useMutation({
    mutationFn: () => post<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup'),
    onSuccess: setSetup,
  });
  const enable2fa = useMutation({
    mutationFn: () => post('/auth/2fa/enable', { secret: setup!.secret, code }),
    onSuccess: () => (setSetup(null), setCode(''), toast('2FA activado'), refresh()),
  });
  const disable2fa = useMutation({
    mutationFn: () => post('/auth/2fa/disable', { password: disablePassword }),
    onSuccess: () => (setDisablePassword(''), toast('2FA desactivado'), refresh()),
  });

  return (
    <>
      <PageHeader title="Mi cuenta" subtitle={session?.user.email} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Contraseña">
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent) => (e.preventDefault(), changePassword.mutate())}
          >
            <ErrorBox error={changePassword.error} />
            <Field label="Contraseña actual">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={passwords.current}
                  onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                />
              )}
            </Field>
            <Field label="Nueva contraseña" hint="Mínimo 12 caracteres.">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={passwords.password}
                  onChange={(e) => setPasswords({ ...passwords, password: e.target.value })}
                />
              )}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" busy={changePassword.isPending}>
                Cambiar
              </Button>
            </div>
          </form>
        </Card>
        <Card title="Verificación en dos pasos (2FA)">
          {session?.user.twoFactorEnabled ? (
            <form
              className="space-y-3"
              onSubmit={(e: FormEvent) => (e.preventDefault(), disable2fa.mutate())}
            >
              <p className="text-sm text-ok">Activada.</p>
              <ErrorBox error={disable2fa.error} />
              <Field label="Contraseña para desactivarla">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    required
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                  />
                )}
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="danger" busy={disable2fa.isPending}>
                  Desactivar 2FA
                </Button>
              </div>
            </form>
          ) : setup ? (
            <form
              className="space-y-3"
              onSubmit={(e: FormEvent) => (e.preventDefault(), enable2fa.mutate())}
            >
              <p className="text-sm">
                Agrega esta clave en tu app de autenticación (Google Authenticator, 1Password,
                Authy…):
              </p>
              <p
                data-testid="totp-secret"
                className="break-all rounded bg-surface p-2 font-mono text-sm tracking-wider"
              >
                {setup.secret}
              </p>
              <p className="break-all text-xs text-muted">{setup.otpauthUrl}</p>
              <ErrorBox error={enable2fa.error} />
              <Field label="Código de 6 dígitos">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    pattern="\d{6}"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                )}
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" busy={enable2fa.isPending}>
                  Activar
                </Button>
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                Pide un código de tu teléfono además de la contraseña.
              </p>
              <Button variant="primary" busy={start2fa.isPending} onClick={() => start2fa.mutate()}>
                Configurar 2FA
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
