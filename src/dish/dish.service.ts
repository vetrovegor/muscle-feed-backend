import { Injectable, NotFoundException } from '@nestjs/common';

import { Dish, DishType, Prisma } from '@prisma/client';
import { PrismaService } from '@prisma/prisma.service';

import { DishRequestDto } from '@admin/dish/dto/dish-request.dto';
import { PaginationDto } from '@dto/pagination.dto';
import { extractLocalizedFields } from '@utils';

@Injectable()
export class DishService {
    constructor(private readonly prismaService: PrismaService) {}

    async getTypes() {
        const types = await this.prismaService.dishType.findMany();

        return { types };
    }

    async getById(id: number) {
        const dish = await this.prismaService.dish.findFirst({
            where: { id },
            include: { dishType: true }
        });

        if (!dish) {
            throw new NotFoundException('Блюдо не найдено');
        }

        return dish;
    }

    createDto(dish: Dish & { dishType: DishType }) {
        const {
            id,
            adminName,
            dishType,
            picture,
            calories,
            weight,
            proteins,
            fats,
            carbohydrates,
            isActive
        } = dish;

        const localizedFields = extractLocalizedFields(dish);

        return {
            id,
            adminName,
            dishType: {
                id: dishType.id,
                name: {
                    ru: dishType.nameRu,
                    he: dishType.nameHe
                }
            },
            picture,
            calories,
            weight,
            proteins,
            fats,
            carbohydrates,
            isActive,
            ...localizedFields
        };
    }

    async create(dto: DishRequestDto) {
        const existingType = await this.prismaService.dishType.findFirst({
            where: { id: dto.dishTypeId }
        });

        if (!existingType) {
            throw new NotFoundException('Тип блюда не найден');
        }

        const createdDish = await this.prismaService.dish.create({
            data: dto,
            include: { dishType: true }
        });

        return { dish: this.createDto(createdDish) };
    }

    async getDtoById(id: number) {
        const dish = await this.getById(id);

        return { dish: this.createDto(dish) };
    }

    async find({
        limit,
        offset,
        search,
        isActive
    }: {
        limit: number;
        offset: number;
        search: string;
        isActive?: boolean;
    }) {
        const where = {
            ...(isActive != undefined && { isActive }),
            ...(search != undefined && {
                adminName: {
                    contains: search,
                    mode: 'insensitive'
                } as Prisma.StringFilter
            })
        };

        const dishesData = await this.prismaService.dish.findMany({
            where,
            include: { dishType: true },
            take: limit,
            skip: offset
        });

        const totalCount = await this.prismaService.dish.aggregate({
            _count: { id: true },
            where
        });

        return new PaginationDto(
            'dishes',
            dishesData,
            totalCount._count.id,
            limit,
            offset
        );
    }

    async update(id: number, dto: DishRequestDto) {
        await this.getById(id);

        const updatedDish = await this.prismaService.dish.update({
            where: { id },
            data: dto,
            include: { dishType: true }
        });

        return { dish: this.createDto(updatedDish) };
    }

    // TODO: удалить картинку
    async delete(id: number) {
        const existingDish = await this.getById(id);

        await this.prismaService.dish.delete({
            where: { id }
        });

        return { dish: this.createDto(existingDish) };
    }
}
