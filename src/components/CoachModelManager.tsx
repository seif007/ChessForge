'use client';

/**
 * "Coach brain" — download / use / remove the optional on-device model.
 *
 * ONE CARD, TWO HOMES. The exact same manager is mounted on the Bots screen
 * (before a coach game) and in the Analyse coach panel. The runtime and the
 * persisted choice live in `session`/`model`, not in either screen, so a model
 * downloaded on one surface is the model the other surface narrates with.
 *
 * All sizes come from the catalog's real Content-Length, so the user commits
 * to an honest download. Failures never take the coach down: it falls back to
 * the offline template and says so right here.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Bar, Btn } from '@/components/ui/Primitives';
import { IconBrain } from '@/components/ui/Icons';
import { useJob } from '@/lib/background';
import { useCoachSession } from '@/lib/coach/useCoachSession';
import {
  COACH_MODEL_JOB, COACH_MODELS, CoachModelDef, CoachModelJobResult, deleteModel,
  ensureActiveModel, formatModelBytes, isModelInstalled, loadModel, startModelDownload,
  unloadModel,
} from '@/lib/coach/model';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';

export function CoachModelManager() {
  const { modelId } = useCoachSession();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [filesVersion, setFilesVersion] = useState(0);

  /*
   * Downloads are owned by `lib/coach/model`, not by this card. Leaving Bots
   * for the board (or Analyse) no longer hides or interrupts the transfer; the
   * job rehydrates here and finishes by attaching the runtime.
   */
  const job = useJob<CoachModelJobResult>(COACH_MODEL_JOB);
  const downloadBusy = job?.status === 'running';
  const pct = downloadBusy ? job.progress.pct : 0;
  const downloadError = job?.status === 'error'
    ? 'The download did not finish. Check the connection and try again — nothing was lost.'
    : null;

  /*
   * Restoring is deliberately here rather than only in the Analyse panel:
   * a user who opens the app straight into Bots must get the model they
   * downloaded last week, without visiting Analyse first. `ensureActiveModel`
   * is single-flight, so two mounted managers cannot load the weights twice.
   */
  useEffect(() => {
    let alive = true;
    void ensureActiveModel().finally(() => {
      if (alive) setRestoring(false);
    });
    return () => { alive = false; };
  }, []);

  const activeDef = COACH_MODELS.find((d) => d.id === modelId) ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const installed = useMemo(
    () => COACH_MODELS.map((d) => isModelInstalled(d)),
    // The job changes the file underneath us; recompute when it settles.
    [filesVersion, modelId, job?.status, job?.startedAt],
  );
  const anyInstalled = installed.some(Boolean);

  async function use(def: CoachModelDef) {
    setBusyId(def.id);
    setError(null);
    try {
      await loadModel(def);
    } catch (e) {
      console.warn('[coach] loading the model failed:', e);
      setError('That model did not load on this phone — the coach keeps using the offline brain.');
    } finally {
      setBusyId(null);
    }
  }

  function download(def: CoachModelDef) {
    setError(null);
    // Fire and forget: the module job owns the transfer and the load. The card
    // may unmount immediately after this tap; completion is persisted there.
    void startModelDownload(def);
  }

  async function remove(def: CoachModelDef) {
    setBusyId(def.id);
    setError(null);
    try {
      if (modelId === def.id) await unloadModel();
      deleteModel(def);
      setFilesVersion((v) => v + 1);
    } catch (e) {
      console.warn('[coach] deleting the model failed:', e);
      setError('Could not delete the file — you can try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function stop() {
    setBusyId(modelId);
    try {
      await unloadModel();
    } finally {
      setBusyId(null);
    }
  }

  const downloadDef = downloadBusy
    ? COACH_MODELS.find((d) => d.id === job?.owner) ?? null
    : null;
  const toggleLabel = open
    ? 'Hide'
    : restoring
      ? 'Checking…'
      : downloadBusy
        ? 'Downloading…'
        : activeDef
          ? 'Change'
          : anyInstalled
            ? 'Choose'
            : 'Get the model';

  return (
    <View style={s.wrap}>
      <View style={s.headRow}>
        <IconBrain size={14} color={colors.gold} />
        <Text style={s.title}>Coach brain</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => setOpen((o) => !o)} accessibilityLabel="Show or hide the model picker">
          <Text style={s.toggle}>{toggleLabel}</Text>
        </Pressable>
      </View>
      <Text style={s.summary}>
        {downloadBusy
          ? `Downloading ${downloadDef?.label ?? 'the model'} · ${pct}% — keep using the app; this continues in the background.`
          : activeDef
            ? `On-device model loaded: ${activeDef.label}`
            : restoring
              ? 'Looking for a model downloaded earlier…'
              : anyInstalled
                ? 'A model is on this phone but not loaded. Open the picker and tap Use.'
                : 'Offline rulebook — solid explanations, tiny download. The coach bot and Analyse share whichever model you download.'}
      </Text>

      {open ? (
        <View style={s.picker}>
          {COACH_MODELS.map((def, i) => {
            const isInstalled = installed[i];
            const downloading = downloadBusy && job?.owner === def.id;
            const busy = busyId === def.id || downloading;
            const active = modelId === def.id;
            const otherBusy = busyId !== null || downloadBusy;
            return (
              <View key={def.id} style={s.modelRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.modelLabel}>{def.label}</Text>
                  <Text style={s.modelNote}>
                    {def.note} · {formatModelBytes(def.bytes)}
                    {isInstalled && !active ? ' · on this phone' : ''}
                  </Text>
                </View>
                {downloading && pct > 0 && pct < 100 ? (
                  <View style={s.progress}>
                    <Bar pct={pct / 100} height={5} />
                    <Text style={s.pctText}>{pct}%</Text>
                  </View>
                ) : null}
                {active ? (
                  <View style={s.rowBtns}>
                    <Text style={s.inUse}>In use</Text>
                    <Btn label="Stop" variant="ghost" small disabled={busy} onPress={() => void stop()} />
                  </View>
                ) : downloading && pct >= 100 ? (
                  <Text style={s.inUse}>Loading…</Text>
                ) : isInstalled ? (
                  <View style={s.rowBtns}>
                    <Btn
                      label="Use"
                      variant="gold"
                      small
                      disabled={otherBusy}
                      onPress={() => void use(def)}
                    />
                    <Btn
                      label="Delete"
                      variant="ghost"
                      small
                      disabled={otherBusy}
                      onPress={() => void remove(def)}
                    />
                  </View>
                ) : (
                  <Btn
                    label={downloading ? 'Downloading…' : 'Download'}
                    variant="sky"
                    small
                    disabled={otherBusy}
                    onPress={() => void download(def)}
                  />
                )}
              </View>
            );
          })}
          <Text style={s.legal}>
            Qwen 2.5 Instruct (Apache-2.0), quantised by its authors. Downloaded once to the phone;
            use Wi-Fi for the first download. The coach quarantines anything the model invents that
            the review cannot back up.
          </Text>
          {error ?? downloadError ? <Text style={s.error}>{error ?? downloadError}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const s = themedStyles(() => ({
  wrap: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
    gap: 4,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    fontWeight: '700',
    color: colors.foreground,
  },
  toggle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.gold,
  },
  summary: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.mutedForeground,
  },
  picker: {
    marginTop: 6,
    gap: 10,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    borderRadius: radii.md,
    backgroundColor: colors.subtleFill,
  },
  modelLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.foreground,
  },
  modelNote: {
    fontSize: 10.5,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  progress: {
    width: 88,
    gap: 4,
  },
  pctText: {
    fontSize: 10,
    color: colors.mutedForeground,
    textAlign: 'right',
  },
  rowBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inUse: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
  },
  legal: {
    fontSize: 10,
    lineHeight: 14,
    color: colors.mutedForeground,
  },
  error: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.destructive,
  },
}));
