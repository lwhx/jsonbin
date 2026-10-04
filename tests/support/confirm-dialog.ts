import { expect } from "@playwright/test";

export async function acceptConfirm(page: any, text?: string) {
  const dialog = page.locator(".confirm-dialog").last();
  await expect(dialog).toBeVisible();
  if (text) await expect(dialog).toContainText(text);
  await dialog.locator('[data-dialog-confirm="true"]').click();
  await expect(dialog).not.toBeVisible();
}

export async function dismissConfirm(page: any, text?: string) {
  const dialog = page.locator(".confirm-dialog").last();
  await expect(dialog).toBeVisible();
  if (text) await expect(dialog).toContainText(text);
  await dialog.locator('[data-dialog-cancel="true"]').click();
  await expect(dialog).not.toBeVisible();
}
