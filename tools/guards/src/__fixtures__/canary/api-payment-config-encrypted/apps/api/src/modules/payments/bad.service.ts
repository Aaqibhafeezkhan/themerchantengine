export class BadPaymentMethodsService {
  async create(dto: { config: Record<string, unknown> }) {
    return this.prisma.paymentMethod.create({
      data: {
        code: 'card',
        config: dto.config as never,
      },
    });
  }
}
