import { route } from "@/lib/api";
import { notificationQueue, retryNotifications } from "@/domain/admin";

export const dynamic = "force-dynamic";
export const GET = route(({ actor, query }) => notificationQueue(actor, query.status));
export const POST = route(({ actor, body }) => retryNotifications(actor, body));
