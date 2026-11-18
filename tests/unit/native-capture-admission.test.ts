import { afterEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { NativeCaptureCaller } from '../../src/server/nativeCaptureAdmission.js';
import type { MobilePairingService } from '../../src/server/mobilePairingRoutes.js';
import * as ownerAuth from '../../src/server/mobileOwnerDeviceAdmission.js';

afterEach(() => vi.restoreAllMocks());
function local() {
  const req = {headers:{host:'127.0.0.1:4042'},socket:{remoteAddress:'127.0.0.1'}} as unknown as Request;
  const device = {status:'active',approvedVia:'local-install',deviceKind:'computer',localBinding:{machineId:'signed-machine'},host:'127.0.0.1:4042'};
  const pairing = {deps:{config:{port:4042}},devices:{get:() => device}} as unknown as MobilePairingService;
  const admission = {deviceId:'desktop',identity:{role:'owner' as const,userId:null,keyHash:'test-key'},isCurrent:vi.fn(() => true)};
  const admitted = vi.spyOn(ownerAuth,'mobileOwnerDeviceAdmission').mockReturnValue(admission);
  return {req,device,admitted,admission,run:() => NativeCaptureCaller.from(req,pairing,'signed-machine')};
}
it('requires a signed owner on the enrolled loopback Mac and rereads revocation after admission',() => {
  const f=local(); const mac=f.run(); expect(mac?.deviceId).toBe('desktop');
  expect(mac?.isCurrent()).toBe(true);f.admission.isCurrent.mockReturnValue(false);
  expect(mac?.isCurrent()).toBe(false);
  f.admitted.mockReturnValue(null);expect(f.run()).toBeNull();
});
it.each(['forwarded','wrong-machine','remote-host','phone','other-enrollment'])('rejects %s authority',bad => {
  const f=local();
  if (bad==='forwarded') f.req.headers['x-forwarded-for']='127.0.0.1';
  if (bad==='wrong-machine') f.device.localBinding.machineId='another';
  if (bad==='remote-host') f.req.headers.host='tunnel.example.test';
  if (bad==='phone') f.device.deviceKind='phone';
  if (bad==='other-enrollment') f.device.approvedVia='dashboard-pin';
  expect(f.run()).toBeNull();
});
