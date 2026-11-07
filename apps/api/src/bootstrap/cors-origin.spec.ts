import { corsOriginCheck } from './cors-origin';

function run(allowed: string[], origin: string | undefined) {
  const callback = jest.fn();
  corsOriginCheck(allowed)(origin, callback);
  return callback;
}

describe('corsOriginCheck', () => {
  it('allows a request with no origin', () => {
    expect(run(['http://a.test'], undefined)).toHaveBeenCalledWith(null, true);
  });

  it('allows a listed origin', () => {
    expect(run(['http://a.test'], 'http://a.test')).toHaveBeenCalledWith(null, true);
  });

  it('refuses an unlisted origin without raising an error', () => {
    const callback = run(['http://a.test'], 'http://evil.test');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, false);
  });
});
