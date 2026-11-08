import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import {
  Box,
  Cursor,
  Flight,
  Glow,
  Plate,
  Press,
  playSound,
  Ripple,
  useDemoTap,
} from "react-isokit";
import { Dimension } from "react-isokit/drafting";
import "react-isokit/styles.css";

type Ad = "a" | "b" | "c";
type Day = "launch" | "prune" | "scale";
type Coins = Readonly<Record<Ad, number>>;
type Coin = { ad: Ad; level: number };
type Move = { from: Coin; to: Coin; lift: number };
type Wheel = { digit: string; before: string; rank: number };
type Schedule = {
  flights: readonly Move[];
  shown: ReadonlyMap<string, number>;
  switches: Readonly<Record<Ad, number>>;
  settled: number;
  wheels: readonly Wheel[];
  turning: number;
};

const BASE = { x: 0, y: 0, z: 0, w: 168, d: 104, h: 10 };
const CARD = { y: 12, w: 40, d: 5, h: 56 };
const COIN = { y: 40, w: 24, d: 24, h: 4, step: 5, inset: 8 };
const KEY = { x: 112, y: 80, z: BASE.h, w: 48, d: 16, h: 5 };
const COUNTER = { x: 50, y: 80, z: BASE.h, w: 44, d: 16, h: 13 };
const WINDOW = { x: 21, y: 2.5, w: 18, h: 8.5 };
const WHEEL = { pitch: 9, size: 7, baseline: 9.3 };
const RELAY = { y: 25, pivot: 15, arm: 6.5, lamp: 28 };
const PAUSE_MS = 260;
const GAP_MS = 110;
const FLIGHT_MS = 520;
const ROLL_STAGGER_MS = 50;
const SLOT_X: Coins = { a: 10, b: 64, c: 118 };
const ADS = (["a", "b", "c"] as const).map((ad) => ({ ad, x: SLOT_X[ad] }));
const LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;
const DAYS = ["launch", "prune", "scale"] as const;
const PLAN: Readonly<
  Record<Day, { coins: Coins; next: Day; day: number; readout: string }>
> = {
  launch: {
    coins: { a: 3, b: 3, c: 3 },
    next: "prune",
    day: 1,
    readout: "illustrative markers · starting view",
  },
  prune: {
    coins: { a: 5, b: 4, c: 0 },
    next: "scale",
    day: 4,
    readout: "illustrative markers · quote view",
  },
  scale: {
    coins: { a: 7, b: 2, c: 0 },
    next: "launch",
    day: 12,
    readout: "illustrative markers · risk view",
  },
};
const EDGE = COIN.w / 2 / Math.SQRT2;
const MEASURED = [
  SLOT_X.a + COIN.inset + COIN.w / 2 - EDGE,
  COIN.y + COIN.d / 2 + EDGE,
] as const;

const xOf = (ad: Ad) => SLOT_X[ad] + COIN.inset;
const at = (coin: Coin) =>
  [xOf(coin.ad), COIN.y, BASE.h + coin.level * COIN.step] as const;
const coinKey = (coin: Coin) => `${coin.ad}-${coin.level}`;
const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
const stackTop = (count: number) =>
  BASE.h + count * COIN.step - (COIN.step - COIN.h);
const digitsOf = (day: Day) => String(PLAN[day].day).padStart(2, "0").split("");

function moves(before: Coins, after: Coins): readonly Move[] {
  const lost = ADS.flatMap(({ ad }) =>
    range(after[ad], before[ad])
      .reverse()
      .map((level) => ({ ad, level })),
  );
  const won = ADS.flatMap(({ ad }) =>
    range(before[ad], after[ad]).map((level) => ({ ad, level })),
  );
  return won.flatMap((to, i) => {
    const from = lost[i];
    return from ? [{ from, to, lift: PAUSE_MS + i * GAP_MS }] : [];
  });
}

function wheelsOf(from: Day, to: Day): { wheels: Wheel[]; turning: number } {
  const before = digitsOf(from);
  const after = digitsOf(to);
  const wheels: Wheel[] = [];
  let turning = 0;
  for (let index = after.length - 1; index >= 0; index--) {
    const digit = after[index] ?? "0";
    const was = before[index] ?? "0";
    wheels[index] = { digit, before: was, rank: digit === was ? -1 : turning };
    if (digit !== was) turning++;
  }
  return { wheels, turning };
}

function schedule(from: Day, to: Day): Schedule {
  const before = PLAN[from].coins;
  const after = PLAN[to].coins;
  const flights = moves(before, after);
  const shown = new Map<string, number>();
  const switches = { a: 0, b: 0, c: 0 };
  let settled = 0;
  for (const move of flights) {
    const landed = move.lift + FLIGHT_MS;
    shown.set(coinKey(move.from), move.lift);
    shown.set(coinKey(move.to), landed);
    if (after[move.from.ad] === 0)
      switches[move.from.ad] = Math.max(switches[move.from.ad], move.lift);
    if (
      before[move.to.ad] === 0 &&
      (switches[move.to.ad] === 0 || landed < switches[move.to.ad])
    )
      switches[move.to.ad] = landed;
    settled = Math.max(settled, landed);
  }
  return { flights, shown, switches, settled, ...wheelsOf(from, to) };
}

const STILL = schedule("launch", "launch");
const ARRIVALS: ReadonlyMap<Day, Schedule> = new Map(
  DAYS.map((day) => [PLAN[day].next, schedule(day, PLAN[day].next)]),
);

function CoinFace() {
  return <circle className="ik-detail" cx={COIN.w / 2} cy={COIN.d / 2} r={7} />;
}

export default function BudgetRack() {
  const [run, setRun] = useState<{ day: Day; moved: boolean; step: number }>({
    day: "launch",
    moved: false,
    step: 0,
  });
  const [touched, setTouched] = useState(false);
  const stops = useRef<Array<() => void>>([]);
  const timers = useRef<number[]>([]);
  const clip = useId().replace(/[^\w-]/g, "");
  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      for (const stop of stops.current) stop();
    },
    [],
  );

  const { day, moved, step } = run;
  const coins = PLAN[day].coins;
  const plan = moved ? (ARRIVALS.get(day) ?? STILL) : STILL;
  const lead =
    day === "launch"
      ? null
      : ADS.reduce((best, slot) =>
          coins[slot.ad] > coins[best.ad] ? slot : best,
        ).ad;
  const advance = (audible: boolean) => {
    const next = PLAN[day].next;
    const coming = ARRIVALS.get(next) ?? STILL;
    for (const timer of timers.current) window.clearTimeout(timer);
    for (const stop of stops.current) stop();
    timers.current = [];
    stops.current = [];
    if (audible) {
      if (coming.turning > 0)
        stops.current.push(
          playSound("roll", {
            count: coming.turning,
            stagger: ROLL_STAGGER_MS / 1000,
          }),
        );
      stops.current.push(
        playSound("cascade", {
          count: coming.flights.length,
          stagger: GAP_MS / 1000,
          delay: (PAUSE_MS + FLIGHT_MS) / 1000,
        }),
      );
      for (const { ad } of ADS) {
        const switchAt = coming.switches[ad];
        if (switchAt > 0)
          timers.current.push(
            window.setTimeout(
              () => stops.current.push(playSound("relay")),
              switchAt,
            ),
          );
      }
    }
    setRun({ day: next, moved: true, step: 1 - step });
  };
  const demo = useDemoTap(
    () => {
      if (day === "launch") advance(false);
    },
    { delay: 700 },
  );
  const press = () => {
    demo.dismiss();
    setTouched(true);
    advance(true);
  };

  return (
    <Plate
      {...demo.plate}
      fig="Illustrative workflow"
      name="Capstan workflow rack"
      hint={day === "scale" ? "Press to start again" : "Press run"}
      readout={PLAN[day].readout}
      className="fig-budget-rack"
      style={{ "--settled": `${plan.settled}ms` } as CSSProperties}
      data-day={day}
      fit={[
        BASE,
        { x: 10, y: CARD.y, z: 0, w: 148, d: CARD.d, h: BASE.h + CARD.h },
      ]}
      aspect={1.3}
      label="An illustrative workflow rack with three stacks of markers. Press run to move them through different arrangements. These are not live market data."
    >
      <defs>
        <clipPath id={clip}>
          <rect
            x={WINDOW.x}
            y={WINDOW.y}
            width={WINDOW.w}
            height={WINDOW.h}
            rx={1.5}
          />
        </clipPath>
      </defs>
      <g ref={demo.ref}>
        <Box
          {...BASE}
          r={10}
          top={
            <>
              {ADS.map(({ ad, x }) => {
                const on = coins[ad] > 0;
                return (
                  <g
                    key={ad}
                    style={
                      { "--switch": `${plan.switches[ad]}ms` } as CSSProperties
                    }
                  >
                    <rect
                      className="ik-well"
                      x={x - 2}
                      y={CARD.y - 2}
                      width={CARD.w + 4}
                      height={CARD.d + 4}
                      rx={2}
                    />
                    <rect
                      className="ik-detail"
                      x={x + COIN.inset - 3}
                      y={COIN.y - 3}
                      width={COIN.w + 6}
                      height={COIN.d + 6}
                      rx={(COIN.w + 6) / 2}
                    />
                    <path
                      className="ik-detail"
                      d={`M${x + RELAY.pivot + RELAY.arm + 1.2} ${RELAY.y - 2.4}v4.8`}
                    />
                    <g transform={`translate(${x + RELAY.pivot} ${RELAY.y})`}>
                      <g className="br-arm" data-on={on}>
                        <path className="ik-line" d={`M0 0h${RELAY.arm}`} />
                      </g>
                      <circle className="ik-fill" r={1} />
                    </g>
                    <Glow on={on} className="br-lamp-glow">
                      <circle
                        className="br-lamp"
                        data-on={on}
                        cx={x + RELAY.lamp}
                        cy={RELAY.y}
                        r={2.2}
                      />
                    </Glow>
                  </g>
                );
              })}
              {[
                [6, BASE.d - 6],
                [BASE.w - 6, 6],
              ].map(([cx, cy]) => (
                <circle
                  key={`${cx}-${cy}`}
                  className="ik-fill"
                  cx={cx}
                  cy={cy}
                  r={1.4}
                />
              ))}
            </>
          }
          front={<path className="ik-detail" d={`M12 5h${BASE.w - 24}`} />}
        />
        {ADS.map(({ ad, x }) => (
          <g
            key={ad}
            className="br-card"
            data-paused={coins[ad] === 0}
            data-lead={lead === ad}
            style={{ "--switch": `${plan.switches[ad]}ms` } as CSSProperties}
          >
            <Box
              x={x}
              y={CARD.y}
              z={BASE.h}
              w={CARD.w}
              d={CARD.d}
              h={CARD.h}
              r={2}
              front={
                <>
                  <rect
                    className="ik-well"
                    x={4}
                    y={4}
                    width={32}
                    height={28}
                    rx={2}
                  />
                  <g className="br-art">
                    <circle className="ik-detail" cx={28} cy={11} r={2.5} />
                    <path
                      className="ik-detail"
                      d="M5 31l9-9 6 6 5-4 10 7M4 37.5h26M4 41.5h18"
                    />
                    <rect
                      className="ik-fill"
                      x={4}
                      y={46}
                      width={16}
                      height={5.5}
                      rx={2.75}
                    />
                  </g>
                  <path
                    className="ik-line ik-thick br-pause"
                    d="M16.5 12v12M23.5 12v12"
                  />
                  <text
                    className="ik-label br-letter"
                    x={36}
                    y={51}
                    textAnchor="end"
                  >
                    {({ a: "M", b: "Q", c: "R" } as const)[ad]}
                  </text>
                </>
              }
              top={
                <path
                  className="ik-detail"
                  d={`M4 ${CARD.d / 2}h${CARD.w - 8}`}
                />
              }
            />
          </g>
        ))}
        {ADS.map(({ ad }) =>
          LEVELS.map((level) => (
            <g
              key={`${ad}-${level}`}
              className="br-coin"
              data-on={level < coins[ad]}
              style={
                {
                  "--t": `${plan.shown.get(coinKey({ ad, level })) ?? 0}ms`,
                } as CSSProperties
              }
            >
              <Box
                x={xOf(ad)}
                y={COIN.y}
                z={BASE.h + level * COIN.step}
                w={COIN.w}
                d={COIN.d}
                h={COIN.h}
                r={COIN.w / 2}
                top={<CoinFace />}
              />
            </g>
          )),
        )}
        <Box
          {...COUNTER}
          r={3}
          top={
            <>
              <circle className="ik-fill" cx={4} cy={COUNTER.d / 2} r={1} />
              <circle
                className="ik-fill"
                cx={COUNTER.w - 4}
                cy={COUNTER.d / 2}
                r={1}
              />
            </>
          }
          front={
            <>
              <text className="ik-label br-tag" x={5} y={9}>
                DAY
              </text>
              <rect
                className="ik-screen"
                x={WINDOW.x}
                y={WINDOW.y}
                width={WINDOW.w}
                height={WINDOW.h}
                rx={1.5}
              />
              <g clipPath={`url(#${clip})`}>
                {plan.wheels.map(({ digit, before, rank }, index) => {
                  const cx = WINDOW.x + index * WHEEL.pitch + WHEEL.pitch / 2;
                  return (
                    <g
                      key={`${index}-${day}`}
                      style={
                        {
                          "--roll-at": `${Math.max(0, rank) * ROLL_STAGGER_MS}ms`,
                        } as CSSProperties
                      }
                    >
                      {rank >= 0 ? (
                        <text
                          className="ik-screen-text br-roll-out"
                          x={cx}
                          y={WHEEL.baseline}
                          fontSize={WHEEL.size}
                          textAnchor="middle"
                        >
                          {before}
                        </text>
                      ) : null}
                      <text
                        className={
                          rank >= 0
                            ? "ik-screen-text br-roll-in"
                            : "ik-screen-text"
                        }
                        x={cx}
                        y={WHEEL.baseline}
                        fontSize={WHEEL.size}
                        textAnchor="middle"
                      >
                        {digit}
                      </text>
                    </g>
                  );
                })}
              </g>
              <path
                className="ik-detail"
                d={`M${WINDOW.x + WHEEL.pitch} ${WINDOW.y}v${WINDOW.h}`}
              />
            </>
          }
          side={<path className="ik-detail" d="M4 4h8M4 6.5h8M4 9h8" />}
        />
        {!touched &&
        day === "launch" &&
        demo.phase !== "aim" &&
        demo.phase !== "press" ? (
          <Ripple {...KEY} r={6} />
        ) : null}
        <Press
          label={
            day === "scale" ? "Start again" : "Show the next arrangement"
          }
          material="plastic"
          onPress={press}
          data-hot={day === "launch"}
        >
          <g>
            <Box
              {...KEY}
              r={6}
              top={
                <>
                  <text className="ik-label br-key" x={7} y={10.6}>
                    RUN
                  </text>
                  <path
                    className="ik-detail ik-thick br-play"
                    d="M0 0l5 3.2L0 6.4z"
                    transform={`translate(${KEY.w - 13} 4.8)`}
                  />
                </>
              }
            />
          </g>
        </Press>
        <g key={step}>
          {plan.flights.map((move) => (
            <Flight
              key={coinKey(move.from)}
              from={at(move.from)}
              to={at(move.to)}
              delay={move.lift}
              duration={FLIGHT_MS}
            >
              <Box
                x={xOf(move.from.ad)}
                y={COIN.y}
                z={BASE.h + move.from.level * COIN.step}
                w={COIN.w}
                d={COIN.d}
                h={COIN.h}
                r={COIN.w / 2}
                top={<CoinFace />}
              />
            </Flight>
          ))}
        </g>
        <Dimension
          from={[MEASURED[0], MEASURED[1], BASE.h]}
          to={[MEASURED[0], MEASURED[1], stackTop(coins.a)]}
          offset={[-8, 8, 0]}
          label={`${coins.a} markers`}
        />
        <Cursor
          at={[KEY.x + KEY.w / 2, KEY.y + KEY.d / 2, KEY.z + KEY.h]}
          phase={demo.phase}
        />
      </g>
    </Plate>
  );
}

