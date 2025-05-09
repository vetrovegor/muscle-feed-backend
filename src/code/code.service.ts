import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '@prisma/prisma.service';

@Injectable()
export class CodeService {
    constructor(private readonly prismaService: PrismaService) {}

    private async deleteUserCodes(userId) {
        return await this.prismaService.code.deleteMany({
            where: {
                userId
            }
        });
    }

    async create(userId: number) {
        const existingCode = await this.prismaService.code.findFirst({
            where: {
                userId,
                retryDate: {
                    gt: new Date()
                }
            }
        });

        if (existingCode) {
            throw new BadRequestException({
                message: { ru: 'Код уже отправлен', he: 'הקוד כבר נשלח' }
            });
        }

        await this.deleteUserCodes(userId);

        const randomCode = Math.floor(Math.random() * 1000000);
        const formattedCode = randomCode.toString().padStart(6, '0');

        const addMinutesToDate = (date: Date, minutes: number) => {
            const newDate = new Date(date);
            newDate.setMinutes(newDate.getMinutes() + minutes);
            return newDate;
        };

        const retryDate = addMinutesToDate(new Date(), 1);
        const expiryDate = addMinutesToDate(new Date(), 5);

        await this.prismaService.code.create({
            data: {
                userId,
                code: formattedCode,
                retryDate,
                expiryDate
            }
        });

        return formattedCode;
    }

    async validateCode(code: string, userId: number) {
        const existingCode = await this.prismaService.code.findFirst({
            where: {
                userId,
                code,
                expiryDate: {
                    gt: new Date()
                }
            }
        });

        if (!existingCode) {
            throw new BadRequestException({
                message: {
                    ru: 'Код недействителен или истек',
                    he: 'הקוד אינו חוקי או פג תוקפו'
                }
            });
        }

        await this.deleteUserCodes(userId);
    }
}
