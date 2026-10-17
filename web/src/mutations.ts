import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, newKey, type Item, type Me, type TransitionAction } from './api';
import { useToast } from './toast';

/** Errors that mean "the world changed under you" — the server tells us the current truth. */
const STALE_CODES = new Set(['VERSION_CONFLICT', 'ALREADY_CLAIMED', 'INVALID_TRANSITION']);

type Vars<T> = T & { key: string };

/**
 * Shared behaviour for every command on an item:
 *  - one idempotency key per user intent, reused by automatic retries (network/5xx only),
 *  - server response replaces the cached item (server is authoritative),
 *  - on stale-state errors the cache is reconciled with the server's current item and the
 *    caller can react (e.g. open a conflict dialog) via onConflict.
 */
export function useItemCommand<T extends object>(
  itemId: number,
  run: (vars: Vars<T>) => Promise<Item>,
  opts: {
    success?: string;
    optimistic?: (item: Item) => Item;
    onConflict?: (err: ApiError, vars: Vars<T>) => boolean | void;
  } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation<Item, ApiError, Vars<T>, { previous?: Item }>({
    mutationFn: run,
    retry: (count, err) => err.retryable && count < 2,
    retryDelay: (n) => 400 * 2 ** n,
    onMutate: async () => {
      if (!opts.optimistic) return {};
      await qc.cancelQueries({ queryKey: ['item', itemId] });
      const previous = qc.getQueryData<Item>(['item', itemId]);
      if (previous) qc.setQueryData(['item', itemId], opts.optimistic(previous));
      return { previous };
    },
    onSuccess: (item) => {
      qc.setQueryData(['item', itemId], item);
      if (opts.success) toast(opts.success, 'success');
    },
    onError: (err, vars, context) => {
      if (context?.previous) qc.setQueryData(['item', itemId], context.previous); // roll back optimism
      if (STALE_CODES.has(err.code) && err.details?.current) {
        qc.setQueryData(['item', itemId], err.details.current);
        if (opts.onConflict?.(err, vars)) return;
        toast(`${err.message}. The item has been refreshed.`, 'warn');
        return;
      }
      toast(err.message, 'error');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['events', itemId] });
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  return {
    ...m,
    /** Generates a fresh idempotency key for this user intent. */
    fire: (vars: T) => m.mutate({ ...vars, key: newKey() } as Vars<T>),
  };
}

export function useClaim(item: Item, me: Me) {
  return useItemCommand<object>(item.id, ({ key }) => api.claim(item.id, key), {
    success: 'You own this now',
    // Optimistic: show yourself as owner immediately; rolled back if someone beat you to it.
    optimistic: (i) => ({ ...i, assignee: { id: me.id, name: me.name }, allowedActions: (i.allowedActions ?? []).filter((a) => a !== 'claim') }),
    onConflict: (err) => {
      if (err.code === 'ALREADY_CLAIMED') return false; // default toast says who owns it
    },
  });
}

export function useTransition(item: Item, onConflict?: (err: ApiError) => boolean | void) {
  return useItemCommand<{ action: TransitionAction; note?: string; version: number }>(
    item.id,
    ({ action, note, version, key }) => api.transition(item.id, version, action, note, key),
    { onConflict },
  );
}
