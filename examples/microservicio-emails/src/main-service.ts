// pnpm --filter example-microservicio-emails service
import { startEmailService } from './emails-service.js';

const service = await startEmailService({
  rabbitUrl: process.env.RABBIT_URL ?? 'amqp://guest:guest@127.0.0.1:5672',
  mailer: { send: async (m) => console.log(`[mailer] para ${m.to}: ${m.subject}`) },
});
console.log('microservicio-emails escuchando tenant.created (Ctrl+C para salir)');
process.once('SIGINT', () => void service.stop().then(() => process.exit(0)));
