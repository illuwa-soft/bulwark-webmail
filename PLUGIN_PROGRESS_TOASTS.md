# Plugin progress toasts

`api.toast.progress(message): Promise<string>` displays the host's indeterminate progress toast until it is dismissed or its sandbox frame is destroyed. It does not disappear after the ordinary five-second notification timeout. No additional manifest permission is required, in Full or Lite.

`api.toast.dismiss(id): Promise<void>` removes only a progress handle created by the same plugin **and frame**. Repeated dismissal, an unknown handle, or a handle from another frame is a no-op. Plugins cannot dismiss native notifications. A user can close the progress toast without cancelling the underlying task; it is not recreated automatically.

```ts
const id = await api.toast.progress('Preparing the document…');
try {
  await prepareDocument();
} finally {
  await api.toast.dismiss(id);
}
```

Starting progress shares the ordinary **five starts per ten seconds per plugin** budget and is limited to **five outstanding progress notices per plugin** across frames. A rejected start rejects its promise; it is not queued. Messages are capped at **300 characters**. Dismissal and frame-destruction cleanup are never rate-limited. A failed activation, navigation away, slot closure, or plugin deactivation destroys the owning frame and removes its progress notices. Ordinary success/error/info/warning behavior remains unchanged.

The plugin owns task completion, failure, cancellation and any terminal message. The host owns the progress display, handle isolation and frame-lifetime cleanup; it contains no product-specific task logic.

Each sandbox instance owns a dedicated `toastLifetime` AbortController, passed to toast dispatch and aborted by `destroy()`. Notification cleanup does not require embedded views, persistent storage or any other downstream extension.

진행 알림은 일반 알림의 5초 만료 대신 명시적 종료 또는 프레임 종료까지 유지됩니다. 플러그인은 작업 성공·실패·취소와 최종 안내를 처리하고, 호스트는 프레임별 알림 소유권·표시·정리만 담당합니다.
