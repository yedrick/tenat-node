import { EntitySchema, type MigrationInterface, type QueryRunner } from 'typeorm';

export interface Tarea {
  id: number;
  titulo: string;
  hecha: boolean;
}

export const TareaSchema = new EntitySchema<Tarea>({
  name: 'Tarea',
  tableName: 'tareas',
  columns: {
    id: { type: Number, primary: true, generated: true },
    titulo: { type: String },
    hecha: { type: Boolean, default: false },
  },
});

/** Migración de TypeORM: corre en el schema de cada tenant al crearlo. */
export class Tareas1767225600000 implements MigrationInterface {
  name = 'Tareas1767225600000';
  async up(q: QueryRunner) {
    await q.query('create table tareas (id serial primary key, titulo varchar(200) not null, hecha boolean not null default false)');
  }
  async down(q: QueryRunner) {
    await q.query('drop table tareas');
  }
}
