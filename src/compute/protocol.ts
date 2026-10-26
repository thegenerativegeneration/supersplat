import type { OrbitPlan } from './orbit-job';
import type { BalanceInput, BalanceResult } from '../anim/balance-timing';
import type { CurveOptions, CurvePose } from '../anim/camera-curve';
import type { Box } from '../candidates/estimate';
import type { SplatExtents } from '../candidates/extent';
import type { Vec3Like } from '../candidates/occupancy';
import type { OrbitSpec } from '../orbit/orbit-path';
import type { FixKey, FixPlan } from '../path/fix-plan';

type Stage = 'reading' | 'estimate' | 'grid' | 'routes' | 'detours' | 'timing' | 'measuring' | 'orbit' | 'checking';

// done and total are absent while a stage cannot count its work
type ProgressFn = (stage: Stage, done?: number, total?: number) => void;

type Estimate = { box: Box, eyeHeight: number, tiltDeg: number, points: number };

// positions: the user key positions the grid's occupancy must cover;
// opening: the smallest opening in scene units, already clamped
type FixPlanRequest = {
    version: number,
    box: Box,
    eyeHeight: number,
    opening: number,
    allowFlying: boolean,
    positions: Vec3Like[],
    keys: FixKey[],
    keepOrder: boolean,
    timeline: Omit<BalanceInput, 'keys'>
};

// FixPlan with key identity replaced by the index into request.keys; box is
// the area the grid's graph covers
type FixPlanReply = Omit<FixPlan, 'poses'> & {
    poses: { pose: CurvePose, frame: number, keyIndex: number | null }[],
    box: Box
};

type OrbitPlanRequest = { version: number, box: Box, eyeHeight: number, spec: OrbitSpec };

// poses and frames of the keys in the shot by frame; first and last: indices
// of the orbit's first and last key in them
type OrbitCheckRequest = {
    version: number,
    box: Box,
    eyeHeight: number,
    poses: CurvePose[],
    frames: number[],
    userFrames: number[],
    first: number,
    last: number,
    curve: CurveOptions
};

type ComputeOps = {
    estimate: { args: { version: number }, result: Estimate },
    fixPlan: { args: FixPlanRequest, result: FixPlanReply },
    orbitPlan: { args: OrbitPlanRequest, result: OrbitPlan },
    orbitCheck: { args: OrbitCheckRequest, result: { orbitBlocked: boolean, joinBlocked: boolean } },
    balance: { args: BalanceInput, result: BalanceResult }
};

// points replaces the scene points the other requests refer to by version
type Request =
    { id: number, op: keyof ComputeOps, args: unknown } |
    { id: number, op: 'points', args: { version: number, points: Float32Array, extents?: SplatExtents } };

// a request gets any number of progress replies, then one result or error
type Reply =
    { id: number, progress: { stage: Stage, done?: number, total?: number } } |
    { id: number, result: unknown } |
    { id: number, error: string };

export type {
    ComputeOps,
    Estimate,
    FixPlanReply,
    FixPlanRequest,
    OrbitCheckRequest,
    OrbitPlanRequest,
    ProgressFn,
    Reply,
    Request,
    Stage
};
