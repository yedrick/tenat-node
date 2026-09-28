import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { del, get, patch, post } from '../api';
import { useAuth, type AdminUser } from '../auth';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  formatDate,
} from '../components/ui';

const ROLES: [string, string][] = [
  ['support', 'support — ver, vaciar caché, impersonar'],
  ['admin', 'admin — además cambiar tenants, migrar, webhooks'],
  ['owner', 'owner — además borrar tenants y usuarios'],
];

export function Users() {
  const { session } = useAuth();
  const client = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<AdminUser[]>('/users') });
  const [creating, setCreating] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ['users'] });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: number; role?: string; active?: boolean }) =>
      patch(`/users/${id}`, body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/users/${id}`),
    onSuccess: refresh,
  });
  return (
    <>
      <PageHeader
        title="Usuarios del panel"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Nuevo usuario
          </Button>
        }
      />
      <ErrorBox error={users.error ?? update.error ?? remove.error} />
      <Card>
        <DataTable
          data={users.data ?? []}
          columns={[
            { header: 'Nombre', cell: ({ row }) => row.original.name },
            { header: 'Email', cell: ({ row }) => row.original.email },
            {
              header: 'Rol',
              cell: ({ row }) => (
                <Select
                  aria-label={`Rol de ${row.original.email}`}
                  options={ROLES.map(([v]) => v)}
                  value={row.original.role}
                  onChange={(e) => update.mutate({ id: row.original.id, role: e.target.value })}
                  disabled={row.original.id === session?.user.id}
                />
              ),
            },
            {
              header: '2FA',
              cell: ({ row }) =>
                row.original.twoFactorEnabled ? (
                  <Badge tone="active">sí</Badge>
                ) : (
                  <Badge tone="skipped">no</Badge>
                ),
            },
            {
              header: 'Estado',
              cell: ({ row }) =>
                row.original.isActive ? (
                  <Badge tone="active">activo</Badge>
                ) : (
                  <Badge tone="suspended">inactivo</Badge>
                ),
            },
            { header: 'Último acceso', cell: ({ row }) => formatDate(row.original.lastLoginAt) },
            {
              header: '',
              id: 'actions',
              cell: ({ row }) =>
                row.original.id !== session?.user.id && (
                  <div className="flex justify-end gap-2">
                    <Button
                      onClick={() =>
                        update.mutate({ id: row.original.id, active: !row.original.isActive })
                      }
                    >
                      {row.original.isActive ? 'Desactivar' : 'Activar'}
                    </Button>
                    <Button variant="ghost" onClick={() => remove.mutate(row.original.id)}>
                      Eliminar
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>
      <CreateUser open={creating} onClose={() => (setCreating(false), refresh())} />
    </>
  );
}

function CreateUser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'support' });
  const create = useMutation({
    mutationFn: () => post('/users', form),
    onSuccess: () => (setForm({ email: '', name: '', password: '', role: 'support' }), onClose()),
  });
  return (
    <Modal title="Nuevo usuario" open={open} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => (e.preventDefault(), create.mutate())}
      >
        <ErrorBox error={create.error} />
        <Field label="Nombre">
          {(id) => (
            <Input
              id={id}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          )}
        </Field>
        <Field label="Contraseña inicial" hint="Mínimo 12 caracteres.">
          {(id) => (
            <Input
              id={id}
              type="password"
              minLength={12}
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          )}
        </Field>
        <Field label="Rol">
          {(id) => (
            <Select
              id={id}
              options={ROLES}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Crear
          </Button>
        </div>
      </form>
    </Modal>
  );
}
