'use client';

/**
 * AppShell — native port of the web `components/AppShell.tsx`.
 *
 * Structure mirrors the web version exactly:
 *   - a centred `max-w-lg` column
 *   - a fixed 6-item bottom tab bar
 *   - three full-screen overlays that REPLACE the tab content: Practice,
 *     Course, and Train. Exiting an overlay returns to whatever was underneath
 *     (Practice deliberately keeps Course mounted below it).
 *
 * Web-to-native notes:
 *   - the web nav is `grid-cols-6`; here it is a flex row of equal-width items
 *   - active-tab accent is `--gold` (#d4af37), not `--primary` — matches the web
 *   - `lucide-react` -> hand-rolled `react-native-svg` icons (./ui/Icons)
 *   - Tailwind `backdrop-blur-md bg-card/95` has no RN equivalent, so the bar is
 *     solid `--card`; on an opaque dark theme the difference is imperceptible
 *   - Android hardware back button exits the topmost overlay (web needed nothing)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppBackground } from '@/components/AppBackground';
import { EngineHost } from '@/components/EngineHost';
import { SoundHost, unlockAudio } from '@/components/SoundHost';
import { CelebrationBanner } from '@/components/CelebrationBanner';
import { colors, fonts, layout, themedStyles } from '@/theme/tokens';
import { hydrateSoundPref } from '@/lib/sounds';
import { useAppStore } from '@/lib/store';

import { HomeScreen } from '@/components/screens/HomeScreen';
import { OpeningsScreen } from '@/components/screens/OpeningsScreen';
import { PracticeScreen } from '@/components/screens/PracticeScreen';
import { CourseScreen } from '@/components/screens/CourseScreen';
import { TrainScreen } from '@/components/screens/TrainScreen';
import { GameOpeningsScreen } from '@/components/screens/GameOpeningsScreen';
import { PuzzlesScreen } from '@/components/screens/PuzzlesScreen';
import { EndgamesScreen } from '@/components/screens/EndgamesScreen';
import { AnalysisScreen } from '@/components/screens/AnalysisScreen';
import { StatsScreen } from '@/components/screens/StatsScreen';
import { ProfileScreen } from '@/components/screens/ProfileScreen';
import { BotsScreen } from '@/components/screens/BotsScreen';
import { BotPlayScreen } from '@/components/screens/BotPlayScreen';
import { ArenaScreen } from '@/components/screens/ArenaScreen';
import { CreateTournamentScreen } from '@/components/screens/CreateTournamentScreen';
import { TournamentScreen } from '@/components/screens/TournamentScreen';
import { ArenaGameScreen } from '@/components/screens/ArenaGameScreen';

import Svg, { Circle, Path } from 'react-native-svg';

/**
 * The web app writes `setTab(t)` from HomeScreen where `t` can be `'profile'`
 * and from the nav where it is a `Tab`. The union includes both routes.
 */
export type Tab =
  | 'home'
  | 'openings'
  | 'puzzles'
  | 'endgames'
  | 'analysis'
  | 'stats'
  | 'bots'
  | 'arena'
  | 'profile';

type TabDef = { id: Tab; label: string; icon: (p: IconProps) => React.ReactElement };

const TABS: TabDef[] = [
  { id: 'home', label: 'Home', icon: IconHome },
  { id: 'openings', label: 'Openings', icon: IconBook },
  { id: 'puzzles', label: 'Puzzles', icon: IconPuzzle },
  { id: 'endgames', label: 'Endgames', icon: IconCrown },
  { id: 'analysis', label: 'Analyze', icon: IconLineChart },
  { id: 'stats', label: 'Stats', icon: IconBarChart },
  { id: 'bots', label: 'Bots', icon: IconBot },
  { id: 'arena', label: 'Arena', icon: IconTrophyTab },
];

export interface PracticeLaunch {
  studyId: string;
  level: number;
  /*
   * Practice is reachable from All Openings and from Home, and from the course opened out of Your
   * Openings, so it inherits the same question the course asks: should this show the user's own
   * moves? It is optional so that a caller which forgets it gets 'all', not a surprise.
   */
  origin?: StudyOrigin;
}

/**
 * WHICH TAB A STUDY WAS OPENED FROM. `'all'` is All Openings, `'mine'` is Your Openings.
 *
 * THE REPORT: *"i tried 'all openings' not 'your openings' and i found out that you changed its
 * behaviour to be like 'your openings' while i specifically told you to not touch it. (showing the
 * moves and choices of user is only in your openings not all openings)"*.
 *
 * Both tabs open the SAME `CourseScreen` through the SAME `courseStudyId`, and a study id says
 * nothing about who asked for it - so a course reached from All Openings had no way to behave
 * differently from the one reached from Your Openings, and inherited the user's own moves and choices
 * with it. This is the value that makes the two screens different again.
 */
export type StudyOrigin = 'all' | 'mine';

export function AppShell() {
  const [tab, setTab] = useState<Tab>('home');
  const [practice, setPractice] = useState<PracticeLaunch | null>(null);
  const [courseStudyId, setCourseStudyId] = useState<string | null>(null);
  /*
   * THE ORIGIN IS STATE, NOT A PROP, BECAUSE THE SCREEN IS NOT THE THING THAT KNOWS.
   *
   * Defaulting to 'all' is the point of it. A screen reached without an origin must not volunteer
   * the user's games, because the safe answer to "should this show what this person actually played?"
   * is no - and a feature that appears by default in the place it was not wanted is worse than one
   * that has to be asked for.
   */
  const [origin, setOrigin] = useState<StudyOrigin>('all');
  /** Open a study in the course, remembering which tab asked. */
  const openCourse = useCallback((studyId: string, from: StudyOrigin) => {
    setCourseStudyId(studyId);
    setOrigin(from);
  }, []);
  const [trainOpen, setTrainOpen] = useState(false);
  /**
   * Which opening Train is confined to, if it was opened from one.
   *
   * Held here rather than inside Train because Train is mounted by a bare boolean: the overlay is
   * either present or not, so a scope passed as a prop has to be cleared by whoever opened the
   * screen. Left set, it would silently narrow the next unrelated Train session.
   */
  const [trainScope, setTrainScope] = useState<string | null>(null);
  // 'Your openings' — the repertoire builder fed by the user's real games.
  const [myOpeningsOpen, setMyOpeningsOpen] = useState(false);
  /**
   * The bot being played, if a game is open.
   *
   * A bot game is an overlay rather than the Bots tab's own body: the board
   * wants the full column, and the tab body scrolls — a board inside a scroll
   * view turns every drag into a fight between the piece and the page.
   */
  const [botPlayId, setBotPlayId] = useState<string | null>(null);
  /**
   * The chosen strength when the opponent is the coach bot.
   *
   * Null means `botPlayId` names a stored player bot. Carrying it beside the id
   * (rather than encoding it into the id) keeps the stored-bot lookup untouched.
   */
  const [coachElo, setCoachElo] = useState<number | null>(null);

  /*
   * ARENA OVERLAYS.
   *
   * The Arena tab is a lobby. Creating, viewing and playing are three full-screen
   * states above it: the form is too tall for a tab body, the standings need the
   * full column, and the board must not live inside a ScrollView. The same
   * precedence as the other overlays applies; the game is the topmost one.
   */
  const [arenaTournamentId, setArenaTournamentId] = useState<string | null>(null);
  const [arenaCreateOpen, setArenaCreateOpen] = useState(false);
  const [arenaGameId, setArenaGameId] = useState<string | null>(null);
  const [arenaAutoStart, setArenaAutoStart] = useState(false);
  /**
   * A PGN HANDED TO THE ANALYSIS PAGE — the bot game's "Game review" route.
   *
   * A bot game is an overlay and Analyse is a tab, so the game cannot be passed parent-to-child
   * directly: the shell holds it for one hop. It is CONSUMED on arrival (the screen copies it into
   * its own box and says so), so returning to the Analyse tab later never re-fills the box over
   * whatever the user has typed or analysed since.
   */
  const [analysisPgn, setAnalysisPgn] = useState<string | null>(null);

  const insets = useSafeAreaInsets();
  const soundRef = useRef<null>(null);

  const load = useAppStore((s) => s.load);
  const loaded = useAppStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    void hydrateSoundPref();
  }, []);

  // Android only lets an AudioContext start inside a user gesture; the first
  // tap in the shell primes it.
  const onFirstTouch = useCallback(() => unlockAudio(soundRef.current), []);

  // If no overlay is open, the active tab's screen renders.
  const overlayOpen =
    practice !== null || courseStudyId !== null || trainOpen || myOpeningsOpen || botPlayId !== null ||
    arenaTournamentId !== null || arenaCreateOpen || arenaGameId !== null;

  /*
   * MOUNT THE ENGINE HOST ONLY WHERE SOMETHING USES THE ENGINE.
   *
   * The host is a WebView running a 7.3 MB wasm build of Stockfish. It was mounted
   * unconditionally, with the comment "mounted once for the whole session - engine boot is
   * expensive", and that is exactly the problem: a WebView is a whole Chromium instance, so
   * every screen paid for one whether it wanted it or not.
   *
   * Measured on the device (SM-A057F, idle on the home screen, release build):
   *
   *     Graphics        44,148 kB   <- the WebView
   *     Private Other   28,888 kB
   *     Native Heap     24,236 kB
   *     System          21,237 kB
   *     Java Heap       10,264 kB   <- the repertoire data, which is FINE
   *     TOTAL PSS      190,697 kB
   *
   * Two conclusions, one of which corrected a wrong guess. The repertoire data is NOT the
   * memory problem: 1,204 studies of JSON land in 10 MB of Java heap, which is what 10 MB of
   * JSON should cost. The engine host is four times that. And the cold start showed
   * `engine up` 1.2 s after `Running "main"`, so it is also a second of the startup that
   * Home and Openings never benefit from.
   *
   * Only three screens touch the engine - Analysis, Endgames and Course. The other eight
   * (Home, Openings, Puzzles, Train, Practice, Your openings, Stats, Profile) do not, and
   * were paying for a Chromium instance anyway.
   *
   * SAFE BECAUSE THE HANDSHAKE WORKS IN EITHER ORDER. `engine.init()` stores its resolver and
   * posts the boot message only if a host is already attached; `attach()` posts it when the
   * host arrives. So a screen may call `init()` while the host is still mounting and be
   * resolved by the `ready` message a moment later. The condition below is exactly the set
   * of screens that call `init()`, which is what keeps the engine's 20 s safety valve from
   * ever firing.
   */
  const engineNeeded = tab === 'analysis'
    || tab === 'endgames'
    || courseStudyId !== null
    // "Your openings" runs the engine too, and INDIRECTLY, which is why it was missed the
    // first time. A screen-by-screen grep for `getEngine`, `engine.init` and
    // `engine.analyse` reported this screen as not using the engine - true of the SCREEN,
    // and useless, because the engine is reached through `analyseFamily` in gameOpenings.
    // With the host unmounted here, that call found no engine: the analysis never ran, the
    // comparison showed "You played  —" with no evaluation, and the user reported both that
    // and that training had nothing to train on.
    //
    // So the rule is not "screens that call the engine API" but "screens whose work needs
    // the engine, however they reach it". A grep cannot answer that question; the fix is to
    // include every screen that analyses something.
    || myOpeningsOpen
    /*
     * STATS ANALYSES GAMES. It was missing here, and it is the worst one to be missing.
     *
     * The note above about Your openings applies here a second time and worse. The list above
     * was built from the claim that "only three screens touch the engine - Analysis, Endgames
     * and Course", with Stats named explicitly among the screens that "do not". Stats calls
     * `getEngine().init()` and then `analyse()` on every position of every game it scans; it
     * touches the engine more than any screen in the app.
     *
     * With the host unmounted, the tap did this:
     *
     *     init()  ->  postBoot() returns at once, because this.host is null
     *             ->  the init handshake is never posted at all
     *             ->  the engine never boots
     *             ->  every analyse() burns its timeout and returns a null eval
     *             ->  the scan has nothing to report and the button appears inert
     *
     * Nothing errored. Nothing warned. The engine simply was never asked to do anything, which
     * is why this read for a long time as "the scan is broken" rather than "the scan has no
     * engine". The tell was one log line: "init deadline of 25s passed with no ready
     * (0 handshake(s) sent)" — zero attempts, because the question was never asked.
     *
     * GATE 1q exists so this cannot happen a third time: it holds a roster of every module
     * that reaches the engine and checks both directions — a new engine-using screen that is
     * not in this condition fails the build, and so does a roster entry quietly dropped from it.
     *
     * THE BOT PLAY SCREEN IS THE FOURTH KIND: reached from the Bots tab but mounted as an
     * overlay, and the roster names the OVERLAY condition rather than the tab, because the
     * Bots tab itself - the list and the builder - never asks the engine for anything. A bot
     * MOVE does, and a move only happens in a game.
     */
    || tab === 'stats'
    || botPlayId !== null
    /*
     * An Arena game is the second overlay that reaches the engine: bot-vs-bot
     * games auto-play here, and human-vs-bot games ask for a move on every bot
     * turn. The LOBBY does not need the engine, but the tournament SHEET does:
     * it plays the bot-only boards out in the background so the user is never
     * forced to sit through them (`arena/autoPlay`).
     */
    || arenaGameId !== null
    || arenaTournamentId !== null;

  /*
   * ONCE THE ENGINE HAS BEEN NEEDED, KEEP IT MOUNTED.
   *
   * `engineNeeded` goes false the moment the user leaves the tab, which unmounts the host, and
   * unmounting calls `engine.destroy()`. That kills the WebView, drops every in-flight search and
   * leaves `ready` false — mid-scan. The Stats screen tells the user *"You can leave this screen —
   * progress is saved after every game"*, and with a host that is torn down on navigation that
   * sentence was simply untrue: leaving the tab silently ended the run.
   *
   * Making the mount sticky keeps the whole point of the optimisation — a user who only ever opens
   * Home and Openings never pays for a Chromium instance — while making the promise true for
   * everyone who does use the engine. The cost is that the engine is not released again once
   * needed, which is the correct trade: it is a session-lifetime resource for anyone who analyses
   * anything, and it is the screen that does the most analysis.
   */
  const [engineEverNeeded, setEngineEverNeeded] = useState(false);
  useEffect(() => {
    if (engineNeeded) setEngineEverNeeded(true);
  }, [engineNeeded]);
  const mountEngine = engineNeeded || engineEverNeeded;

  // Android hardware back: close the topmost overlay first, else default.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (arenaGameId) { setArenaGameId(null); return true; }
      if (arenaCreateOpen) { setArenaCreateOpen(false); return true; }
      if (arenaTournamentId) { setArenaTournamentId(null); setArenaAutoStart(false); return true; }
      if (practice) { setPractice(null); return true; }
      if (courseStudyId) { setCourseStudyId(null); return true; }
      if (botPlayId) { setBotPlayId(null); setCoachElo(null); return true; }
      if (myOpeningsOpen) { setMyOpeningsOpen(false); return true; }
      if (trainOpen) { setTrainOpen(false); return true; }
      return false;
    });
    return () => sub.remove();
  }, [practice, courseStudyId, trainOpen, myOpeningsOpen, botPlayId, arenaGameId, arenaCreateOpen, arenaTournamentId]);

  return (
    <View style={styles.root}>
      <AppBackground />

      {/* The engine WebView, mounted only once something needs it and then kept - see
          `engineNeeded` above for the measurement that motivated it and GATE 1q for the
          invariant that keeps it honest. */}
      {mountEngine ? <EngineHost /> : null}
      <SoundHost />

      <View style={styles.column}>
        {overlayOpen ? (
          <View style={[styles.fill, { paddingTop: insets.top }]}>
            {arenaGameId && arenaTournamentId ? (
              <ArenaGameScreen
                key={arenaGameId}
                tournamentId={arenaTournamentId}
                gameId={arenaGameId}
                onExit={() => setArenaGameId(null)}
                onAnalyse={(pgn) => {
                  setArenaGameId(null);
                  setArenaTournamentId(null);
                  setArenaAutoStart(false);
                  setAnalysisPgn(pgn);
                  setTab('analysis');
                }}
              />
            ) : arenaCreateOpen ? (
              <CreateTournamentScreen
                onCancel={() => setArenaCreateOpen(false)}
                onCreated={(id, autoStart) => {
                  setArenaCreateOpen(false);
                  setArenaTournamentId(id);
                  setArenaAutoStart(autoStart);
                }}
                onManageBots={() => {
                  setArenaCreateOpen(false);
                  setTab('bots');
                }}
              />
            ) : arenaTournamentId ? (
              <TournamentScreen
                tournamentId={arenaTournamentId}
                autoStart={arenaAutoStart}
                onBack={() => {
                  setArenaTournamentId(null);
                  setArenaAutoStart(false);
                }}
                onOpenGame={(id) => {
                  setArenaAutoStart(false);
                  setArenaGameId(id);
                }}
              />
            ) : practice ? (
              <PracticeScreen
                key={practice.studyId}
                studyId={practice.studyId}
                initialLevel={practice.level}
                origin={practice.origin ?? 'all'}
                onExit={() => setPractice(null)}
                onOpenStudy={(id) => setPractice({
                  studyId: id,
                  level: useAppStore.getState().studies[id]?.level ?? 1,
                  origin,
                })}
              />
            ) : courseStudyId ? (
              <CourseScreen
                key={courseStudyId}
                studyId={courseStudyId}
                origin={origin}
                onExit={() => setCourseStudyId(null)}
                onOpenStudy={(id) => openCourse(id, origin)}
                onPractice={(id) => {
                  // keep the course underneath — exiting Practice returns to this study
                  setPractice({
                    studyId: id,
                    level: useAppStore.getState().studies[id]?.level ?? 1,
                    // Inherit: reaching Practice through a course means the course's origin.
                    origin,
                  });
                }}
              />
            ) : trainOpen ? (
              <TrainScreen
                onExit={() => { setTrainOpen(false); setTrainScope(null); }}
                scopeOpeningId={trainScope}
              />
            ) : myOpeningsOpen ? (
              <GameOpeningsScreen
                onExit={() => setMyOpeningsOpen(false)}
                /*
                 * "Train" from the builder: close this overlay and open the
                 * drill. Sequential on purpose — the user should not end up with
                 * two stacked modals, and Train reads the adopted moves on mount,
                 * so the decisions just made are picked up.
                 *
                 * The opening id travels WITH the request. Train is meant to drill positions
                 * from what he has learned *in Your openings*, and arriving without the opening
                 * produced a session full of material from openings he was not looking at. The
                 * scope is cleared on exit so it cannot outlive the screen that set it.
                 */
                onTrain={(openingId) => {
                  setMyOpeningsOpen(false);
                  setTrainScope(openingId ?? null);
                  setTrainOpen(true);
                }}
                /*
                 * "Read our study" from a finished line: close the builder and
                 * open that study in the course, so the user can read the full
                 * lesson for an opening he has just found out he plays.
                 */
                onCourse={(studyId) => { setMyOpeningsOpen(false); openCourse(studyId, 'mine'); }}
              />
            ) : botPlayId ? (
              /*
               * `key` remounts the screen per bot: without it, moving from one bot to
               * another would keep the first game's position and the first bot's habits
               * alive under the second bot's name.
               */
              <BotPlayScreen
                key={coachElo != null ? `coach:${coachElo}` : botPlayId}
                botId={botPlayId}
                coachElo={coachElo}
                onExit={() => {
                  setBotPlayId(null);
                  setCoachElo(null);
                }}
                /*
                 * "Game review": close the game and open Analyse with this game's PGN already in
                 * the box, ready for a depth and a tap. Closing (rather than stacking) keeps one
                 * overlay at a time, which is the shell's rule everywhere.
                 */
                onAnalyse={(pgn) => {
                  setBotPlayId(null);
                  setCoachElo(null);
                  setAnalysisPgn(pgn);
                  setTab('analysis');
                }}
              />
            ) : null}
          </View>
        ) : (
          <>
            <ScrollView
              style={styles.fill}
              contentContainerStyle={[
                styles.content,
                { paddingTop: insets.top + 8, paddingBottom: layout.tabBarClearance + insets.bottom },
              ]}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <ScreenFor
                tab={tab}
                onNavigate={(t) => (t === 'profile' ? setTab('profile') : setTab(t))}
                onPractice={(id, level) => setPractice({ studyId: id, level, origin: 'all' })}
                onCourse={(id) => openCourse(id, 'all')}
                onTrain={() => setTrainOpen(true)}
                onMyOpenings={() => setMyOpeningsOpen(true)}
                onPlayBot={(id, elo) => {
                  setBotPlayId(id);
                  setCoachElo(elo ?? null);
                }}
                onBackHome={() => setTab('home')}
                onOpenArenaTournament={(id) => {
                  setArenaTournamentId(id);
                  setArenaAutoStart(false);
                }}
                onCreateArena={() => setArenaCreateOpen(true)}
                analysisPgn={analysisPgn}
                onAnalysisPgnConsumed={() => setAnalysisPgn(null)}
              />
            </ScrollView>

            <TabBar
              current={tab}
              onSelect={(t) => {
                onFirstTouch();
                setTab(t);
              }}
              bottomInset={insets.bottom}
            />
          </>
        )}
      </View>

      {/*
        The streak celebration — LAST CHILD ON PURPOSE. React Native paints later siblings on top,
        so being after the column means the banner can appear over whichever tab OR overlay raised
        it (an endgame win, a Practice line summary, a puzzle result) without knowing or caring
        which one is up. It is non-blocking — see the component's own header for why it is a banner
        and not a second modal fighting the session summaries.
      */}
      <CelebrationBanner />
    </View>
  );
}

/* ------------------------------------------------------------------ tab bar */

function TabBar({
  current,
  onSelect,
  bottomInset,
}: {
  current: Tab;
  onSelect: (t: Tab) => void;
  bottomInset: number;
}) {
  return (
    <View
      style={[
        styles.tabBar,
        { paddingBottom: Math.max(bottomInset, 6), height: layout.tabBarHeight + Math.max(bottomInset, 6) },
      ]}
    >
      {TABS.map(({ id, label, icon: Icon }) => {
        const active = id === current;
        return (
          <Pressable
            key={id}
            style={styles.tabItem}
            onPress={() => onSelect(id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={label}
          >
            <Icon size={21} color={active ? colors.gold : colors.mutedForeground} strokeWidth={active ? 2.4 : 1.8} />
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
              {label}
            </Text>
            {/* the web draws a small gold underline under the active tab */}
            <View style={[styles.tabUnderline, active && styles.tabUnderlineActive]} />
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------ screen router */

function ScreenFor({
  tab,
  onNavigate,
  onPractice,
  onCourse,
  onTrain,
  onMyOpenings,
  onPlayBot,
  onBackHome,
  onOpenArenaTournament,
  onCreateArena,
  analysisPgn,
  onAnalysisPgnConsumed,
}: {
  tab: Tab;
  onNavigate: (t: Tab) => void;
  onPractice: (studyId: string, level: number) => void;
  onCourse: (studyId: string) => void;
  onTrain: () => void;
  onMyOpenings: () => void;
  onPlayBot: (botId: string, coachElo?: number) => void;
  onBackHome: () => void;
  onOpenArenaTournament: (id: string) => void;
  onCreateArena: () => void;
  /** A PGN for the Analyse tab to open with — see the AppShell state that fills it. */
  analysisPgn: string | null;
  onAnalysisPgnConsumed: () => void;
}) {
  switch (tab) {
    case 'home':
      return <HomeScreen onNavigate={onNavigate} onPractice={onPractice} onTrain={onTrain} />;
    case 'openings':
      return (
        <OpeningsScreen
          onPractice={onPractice}
          onCourse={onCourse}
          onTrain={onTrain}
          onMyOpenings={onMyOpenings}
        />
      );
    case 'puzzles':
      return <PuzzlesScreen />;
    case 'endgames':
      return <EndgamesScreen />;
    case 'analysis':
      return <AnalysisScreen initialPgn={analysisPgn} onConsumeInitialPgn={onAnalysisPgnConsumed} />;
    case 'stats':
      return <StatsScreen />;
    case 'bots':
      return <BotsScreen onPlay={onPlayBot} />;
    case 'arena':
      return (
        <ArenaScreen
          onOpenTournament={onOpenArenaTournament}
          onCreate={onCreateArena}
          onManageBots={() => onNavigate('bots')}
        />
      );
    case 'profile':
      return <ProfileScreen onBack={onBackHome} />;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------- icons */

type IconProps = { size?: number; color?: string; strokeWidth?: number };

function svgProps(p: IconProps) {
  return {
    stroke: p.color ?? colors.foreground,
    strokeWidth: p.strokeWidth ?? 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
}

function IconHome(p: IconProps) {
  const s = p.size ?? 21;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path d="M3 10.5 12 3l9 7.5" {...svgProps(p)} />
      <Path d="M5.5 9.5V20h13V9.5" {...svgProps(p)} />
    </Svg>
  );
}

/**
 * The tab-bar bot: a chess-playing machine.
 *
 * Antenna, head, two eyes, a mouth — the universal glyph, drawn at the tab
 * bar's stroke weight so it sits with the others instead of looking pasted in.
 * The eyes are FILLED rather than stroked, because two 1-px circles at 21 px
 * read as dust otherwise.
 */
function IconBot(p: IconProps) {
  const s = p.size ?? 21;
  const fill = p.color ?? colors.foreground;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path d="M12 2.5v2.8" {...svgProps(p)} />
      <Circle cx="12" cy="2" r="1" {...svgProps(p)} fill={fill} />
      <Path d="M8.5 5.3h7a2.7 2.7 0 0 1 2.7 2.7v8a2.7 2.7 0 0 1-2.7 2.7h-7A2.7 2.7 0 0 1 5.8 16V8A2.7 2.7 0 0 1 8.5 5.3Z" {...svgProps(p)} />
      <Circle cx="9.6" cy="10.4" r="1" {...svgProps(p)} fill={fill} />
      <Circle cx="14.4" cy="10.4" r="1" {...svgProps(p)} fill={fill} />
      <Path d="M9.8 14.6h4.4" {...svgProps(p)} />
    </Svg>
  );
}

/**
 * The tab-bar book.
 *
 * It was a CLOSED book — a spine on the right, two page edges — while the Home screen's Openings card
 * uses the open-book glyph from `Icons.tsx`. The same tab therefore had two different icons depending
 * on which screen you were looking at it from, which is the kind of small inconsistency a user reads
 * as "this is a different app". It is now the same two-page spread as the card, at the tab bar's
 * stroke weight and default size.
 */
function IconBook(p: IconProps) {
  const s = p.size ?? 21;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path d="M2 4.5h6.5A3.5 3.5 0 0 1 12 8v12a3 3 0 0 0-3-3H2z" {...svgProps(p)} />
      <Path d="M22 4.5h-6.5A3.5 3.5 0 0 0 12 8v12a3 3 0 0 1 3-3h7z" {...svgProps(p)} />
    </Svg>
  );
}

function IconPuzzle(p: IconProps) {
  const s = p.size ?? 21;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path
        d="M9.5 4.5a2 2 0 1 1 4 0V6h3a1 1 0 0 1 1 1v3h1.5a2 2 0 1 1 0 4H18v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V18H7a1 1 0 0 1-1-1v-3H4.5a2 2 0 1 1 0-4H6V7a1 1 0 0 1 1-1h2.5z"
        {...svgProps(p)}
      />
    </Svg>
  );
}

function IconCrown(p: IconProps) {
  const s = p.size ?? 21;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path d="M4 18h16" {...svgProps(p)} />
      <Path d="M5 9.5 8 15h8l3-5.5-3.2 1.6L12 6l-3.8 5.1z" {...svgProps(p)} />
    </Svg>
  );
}

function IconLineChart(p: IconProps) {
  const s = p.size ?? 21;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path d="M3.5 16.5 9 11l3.5 3.5L20 7" {...svgProps(p)} />
      <Path d="M15.5 7H20v4.5" {...svgProps(p)} />
    </Svg>
  );
}

/**
 * The Arena tab: a trophy, deliberately the same silhouette as the trophy used
 * on the Arena screens so the destination is recognisable before the label is
 * read.
 */
function IconTrophyTab(p: IconProps) {
  const s = p.size ?? 21;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path d="M8 4h8v5a4 4 0 0 1-8 0z" {...svgProps(p)} />
      <Path d="M8 6H5v2a3 3 0 0 0 3 3" {...svgProps(p)} />
      <Path d="M16 6h3v2a3 3 0 0 1-3 3" {...svgProps(p)} />
      <Path d="M12 13v4" {...svgProps(p)} />
      <Path d="M8.5 20h7" {...svgProps(p)} />
      <Path d="M9.5 17h5v3h-5z" {...svgProps(p)} />
    </Svg>
  );
}

function IconBarChart(p: IconProps) {
  const s = p.size ?? 21;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <Path d="M4 20h16" {...svgProps(p)} />
      <Path d="M7 20v-9" {...svgProps(p)} />
      <Path d="M12 20V5" {...svgProps(p)} />
      <Path d="M17 20v-6" {...svgProps(p)} />
      <Circle cx={12} cy={5} r={0.6} fill={p.color ?? colors.foreground} stroke="none" />
    </Svg>
  );
}

/* -------------------------------------------------------------------- styles */

const styles = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.background },
  column: { flex: 1, width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
  fill: { flex: 1 },
  content: { paddingHorizontal: 16 },

  tabBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingTop: 8 },
  tabLabel: { fontFamily: fonts.sansMedium, fontSize: 10, color: colors.mutedForeground },
  tabLabelActive: { color: colors.gold },
  tabUnderline: { width: 24, height: 2, borderRadius: 999, backgroundColor: 'transparent' },
  tabUnderlineActive: { backgroundColor: colors.gold },
}));
