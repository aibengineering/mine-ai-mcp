import type { NotificationSummary } from "../bot-data/event-log.js";

export function formatNotifications(notifications: NotificationSummary): string | null {
  if (notifications.unreadCount === 0) return null;
  const previews = notifications.recentPreview?.map((preview) => `- ${preview}`) ?? [];
  return [
    "## Notifications",
    `**${notifications.unreadCount} unread notification${notifications.unreadCount === 1 ? "" : "s"}.**`,
    ...(previews.length ? [previews.join("\n")] : []),
    notifications.hint,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}
