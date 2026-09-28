import { describe, expect, it } from 'vitest';
import {
  createEmergencySchema,
  createQuoteSchema,
  createReviewSchema,
  createVehicleSchema,
  loginSchema,
  paginationSchema,
  presignUploadSchema,
  registerSchema,
  verifyOtpSchema,
} from './index';

describe('auth schemas', () => {
  it('normalizes email and applies locale default on register', () => {
    const parsed = registerSchema.parse({
      fullName: '  Yash Rajora ',
      email: '  YASH@Motoro.TEST ',
      password: 'Demo@1234',
      role: 'DRIVER',
    });
    expect(parsed.email).toBe('yash@motoro.test');
    expect(parsed.fullName).toBe('Yash Rajora');
    expect(parsed.locale).toBe('en');
  });

  it('rejects passwords that fail the strength rules', () => {
    expect(registerSchema.safeParse({
      fullName: 'Yash',
      email: 'y@motoro.test',
      password: 'short',
      role: 'DRIVER',
    }).success).toBe(false);

    expect(registerSchema.safeParse({
      fullName: 'Yash',
      email: 'y@motoro.test',
      password: 'alllettersonly',
      role: 'DRIVER',
    }).success).toBe(false);

    expect(registerSchema.safeParse({
      fullName: 'Yash',
      email: 'y@motoro.test',
      password: '12345678',
      role: 'DRIVER',
    }).success).toBe(false);
  });

  it('rejects unknown roles', () => {
    const result = registerSchema.safeParse({
      fullName: 'Yash',
      email: 'y@motoro.test',
      password: 'Demo@1234',
      role: 'ADMIN',
    });
    expect(result.success).toBe(false);
  });

  it('requires a non-empty login password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.test', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.test', password: 'x' }).success).toBe(true);
  });
});

describe('paginationSchema', () => {
  it('coerces query strings and applies defaults', () => {
    const parsed = paginationSchema.parse({ limit: '25', offset: '50' });
    expect(parsed).toEqual({ limit: 25, offset: 50 });
    expect(paginationSchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it('rejects out-of-range limits', () => {
    expect(paginationSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('createEmergencySchema', () => {
  const base = {
    issueType: 'BATTERY',
    latitude: 19.076,
    longitude: 72.8777,
  };

  it('accepts a minimal request and fills defaults', () => {
    const parsed = createEmergencySchema.parse(base);
    expect(parsed.urgency).toBe('NORMAL');
    expect(parsed.channel).toBe('WEB');
  });

  it('rejects unknown issue types and bad coordinates', () => {
    expect(createEmergencySchema.safeParse({ ...base, issueType: 'ALIEN' }).success).toBe(false);
    expect(createEmergencySchema.safeParse({ ...base, latitude: 91 }).success).toBe(false);
    expect(createEmergencySchema.safeParse({ ...base, longitude: -181 }).success).toBe(false);
    expect(createEmergencySchema.safeParse({ ...base, latitude: Number.NaN }).success).toBe(false);
  });

  it('accepts accident mode payloads', () => {
    const parsed = createEmergencySchema.parse({
      ...base,
      urgency: 'CRITICAL',
      accidentMode: {
        driverInjured: false,
        anyoneInjured: true,
        blockingTraffic: true,
        needsTowing: true,
        medicalAssistance: true,
        policeAssistance: false,
      },
    });
    expect(parsed.accidentMode?.anyoneInjured).toBe(true);
  });
});

describe('createVehicleSchema', () => {
  it('uppercases and validates registration numbers', () => {
    const parsed = createVehicleSchema.parse({
      registrationNumber: ' dl 3s ab 1234 ',
      make: 'Maruti',
      model: 'Swift',
      fuelType: 'PETROL',
      vehicleType: 'CAR',
      year: 2021,
    });
    expect(parsed.registrationNumber).toBe('DL 3S AB 1234');
  });

  it('rejects invalid registration characters and fuel types', () => {
    const base = { make: 'Maruti', model: 'Swift', fuelType: 'PETROL', vehicleType: 'CAR' };
    expect(createVehicleSchema.safeParse({ ...base, registrationNumber: '!!' }).success).toBe(false);
    expect(createVehicleSchema.safeParse({ ...base, registrationNumber: 'DL 3S AB 1234', fuelType: 'COAL' }).success).toBe(false);
    expect(createVehicleSchema.safeParse({ ...base, registrationNumber: 'DL 3S AB 1234', year: 1800 }).success).toBe(false);
  });
});

describe('job schemas', () => {
  it('requires a 6-digit OTP', () => {
    expect(verifyOtpSchema.safeParse({ otp: '123456' }).success).toBe(true);
    expect(verifyOtpSchema.safeParse({ otp: '12345' }).success).toBe(false);
    expect(verifyOtpSchema.safeParse({ otp: '12345a' }).success).toBe(false);
  });

  it('computes quote inputs with defaults', () => {
    const parsed = createQuoteSchema.parse({
      items: [
        { type: 'PART', description: 'Battery', quantity: 1, unitPriceCents: 450000 },
        { type: 'DISCOUNT', description: 'Loyalty', quantity: 1, unitPriceCents: 10000 },
      ],
    });
    expect(parsed.taxPercent).toBe(18);
    expect(parsed.items).toHaveLength(2);

    expect(createQuoteSchema.safeParse({
      items: [{ type: 'PART', description: 'Battery', quantity: 0, unitPriceCents: 100 }],
    }).success).toBe(false);

    expect(createQuoteSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('bounds review ratings to 1..5', () => {
    const base = {
      requestId: 'req_1',
      overall: 5,
      arrival: 5,
      diagnosis: 4,
      pricing: 5,
      professionalism: 5,
      resolution: 5,
    };
    expect(createReviewSchema.safeParse(base).success).toBe(true);
    expect(createReviewSchema.safeParse({ ...base, overall: 6 }).success).toBe(false);
    expect(createReviewSchema.safeParse({ ...base, overall: 0 }).success).toBe(false);
  });
});

describe('presignUploadSchema', () => {
  it('accepts images and rejects oversize or unknown types', () => {
    const base = { contentType: 'image/jpeg', purpose: 'breakdown', sizeBytes: 1024 };
    expect(presignUploadSchema.safeParse(base).success).toBe(true);
    expect(presignUploadSchema.safeParse({ ...base, contentType: 'image/gif' }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ ...base, purpose: 'random' }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ ...base, sizeBytes: 0 }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ ...base, sizeBytes: 64 * 1024 * 1024 }).success).toBe(false);
  });
});
