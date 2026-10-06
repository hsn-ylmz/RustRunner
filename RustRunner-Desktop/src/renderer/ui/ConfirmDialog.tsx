/**
 * The in-app confirmation for an action that throws work away. It replaces the
 * operating system's confirm box, so it matches the app, works in both themes
 * and can be driven the same way as any other dialog. The cancel button is
 * focused first: pressing Enter by reflex never destroys anything.
 */

import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmRequest {
  title: string;
  message: string;
  /** The verb on the confirm button, for example "Discard changes". */
  confirmLabel: string;
}

export function ConfirmDialog({
  request,
  onResolve,
}: {
  request: ConfirmRequest;
  onResolve: (confirmed: boolean) => void;
}) {
  return (
    <Dialog
      title={request.title}
      onClose={() => onResolve(false)}
      testId="confirm-dialog"
      footer={
        <>
          <Button autoFocus data-testid="confirm-cancel" onClick={() => onResolve(false)}>
            Cancel
          </Button>
          <Button variant="danger" data-testid="confirm-accept" onClick={() => onResolve(true)}>
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="dialog-message">{request.message}</p>
    </Dialog>
  );
}
