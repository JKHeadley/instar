import {afterEach,describe,expect,it,vi} from 'vitest';
import {forgetKeychainReads,noteKeychainNotFound,readKeychainMemoized} from '../../src/core/SecretStore.js';
afterEach(()=>{forgetKeychainReads();vi.useRealTimers();});
describe('keychain read memo',()=>{
 it('asks the keychain once within the minute, and hands out a copy',()=>{
  const read=vi.fn(()=>Buffer.from('key-bytes')),first=readKeychainMemoized('s','a',read);expect(readKeychainMemoized('s','a',read)!.toString()).toBe('key-bytes');expect(read).toHaveBeenCalledTimes(1);
  // A caller wiping its copy must not wipe what later readers get.
  const second=readKeychainMemoized('s','a',read)!;second.fill(0);expect(readKeychainMemoized('s','a',read)!.toString()).toBe('key-bytes');expect(first!.toString()).toBe('key-bytes');
 });
 it('remembers a genuine not-found, but never a failure, since a false no-key could lead to overwriting a real key',()=>{
  const absent=vi.fn(()=>{noteKeychainNotFound();return null;});expect(readKeychainMemoized('s','missing',absent)).toBeNull();expect(readKeychainMemoized('s','missing',absent)).toBeNull();expect(absent).toHaveBeenCalledTimes(1);
  const failing=vi.fn(()=>null);expect(readKeychainMemoized('s','flaky',failing)).toBeNull();expect(readKeychainMemoized('s','flaky',failing)).toBeNull();expect(failing).toHaveBeenCalledTimes(2);
 });
 it('a failure after a not-found elsewhere is still not remembered',()=>{noteKeychainNotFound();const failing=vi.fn(()=>null);readKeychainMemoized('s','flaky2',failing);readKeychainMemoized('s','flaky2',failing);expect(failing).toHaveBeenCalledTimes(2);});
 it('keeps accounts apart',()=>{expect(readKeychainMemoized('s','one',()=>Buffer.from('1'))!.toString()).toBe('1');expect(readKeychainMemoized('s','two',()=>Buffer.from('2'))!.toString()).toBe('2');});
 it('asks again after the minute, and after a keychain write clears it',()=>{
  vi.useFakeTimers();vi.setSystemTime(1_000_000);const read=vi.fn(()=>Buffer.from('k'));readKeychainMemoized('s','a',read);vi.setSystemTime(1_000_000+59_000);readKeychainMemoized('s','a',read);expect(read).toHaveBeenCalledTimes(1);
  vi.setSystemTime(1_000_000+60_000);readKeychainMemoized('s','a',read);expect(read).toHaveBeenCalledTimes(2);
  forgetKeychainReads();readKeychainMemoized('s','a',read);expect(read).toHaveBeenCalledTimes(3);
  // A clock stepping backwards must not extend a remembered value.
  vi.setSystemTime(1_000_000);readKeychainMemoized('s','a',read);expect(read).toHaveBeenCalledTimes(4);
 });
});
