import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Public } from '../auth/decorators.js';
import { PublicRateLimitGuard } from '../../common/public-rate-limit.guard.js';
import { LeadsService } from './leads.service.js';

/** What the marketing page's enquiry form sends. */
export class CreateLeadDto {
  @IsIn(['demo', 'website'])
  topic!: 'demo' | 'website';

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  clinic!: string;

  @IsString()
  @Matches(/^[+0-9 ()-]{10,16}$/, { message: 'phone must be a 10-digit mobile number' })
  phone!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  city!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /**
   * A field real visitors never see. Bots that fill every input fill this one
   * too, and their request is accepted and quietly dropped.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

/**
 * Demo and website requests from the public marketing page.
 *
 * Public because the person asking is not a user yet. Two throttles sit in
 * front of it: the shared per-IP guard every public route uses, and a much
 * tighter per-IP cap inside the service, since each accepted request sends an
 * email.
 */
@Controller()
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Post('leads')
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() dto: CreateLeadDto,
    @Req() req: FastifyRequest,
  ): Promise<{ status: 'received' }> {
    await this.leads.submit(dto, req.ip);
    return { status: 'received' };
  }
}
