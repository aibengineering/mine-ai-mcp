/**
 * Server physics on a real 1 ms interval, independent of the code under test:
 * each interval runs `beforeTick`, then emits `physicsTick`. A test uses this
 * when the code it drives waits for ticks it does not schedule itself, as a
 * server's ticks arrive whether or not the bot is ready for them, and the
 * scripted world must move between those ticks. Hold the result with `using`
 * so the interval stops even when an assertion throws.
 */
export function physicsEveryMillisecond(
  bot: { emit(event: "physicsTick"): unknown },
  beforeTick: () => void = () => {},
): Disposable {
  const timer = setInterval(() => {
    beforeTick();
    bot.emit("physicsTick");
  }, 1);
  return { [Symbol.dispose]: () => clearInterval(timer) };
}
