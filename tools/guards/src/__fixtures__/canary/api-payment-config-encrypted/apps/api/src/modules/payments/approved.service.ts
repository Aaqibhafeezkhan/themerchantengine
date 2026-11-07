export class ApprovedPaymentMethodsService {
  async create(dto: { config?: Record<string, unknown> }) {
    return this.prisma.paymentMethod.create({
      data: {
        code: 'card',
        config: this.crypto.encrypt(dto.config ?? {}, ['secretKey']) as never,
      },
    });
  }

  async update(id: string, dto: { config?: Record<string, unknown> }) {
    const merged = dto.config !== undefined ? this.crypto.encrypt(dto.config, []) : undefined;
    return this.prisma.paymentMethod.update({
      where: { id },
      data: { ...(merged !== undefined && { config: merged as never }) },
    });
  }

  async seed() {
    return this.prisma.paymentMethod.create({ data: { code: 'cod', config: {} } });
  }
}
